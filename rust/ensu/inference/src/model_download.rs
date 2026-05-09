use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::header::RANGE;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use tokio::runtime::Builder;
use tokio::time::timeout;

const MIN_GGUF_BYTES: u64 = 1024 * 1024;
const MAX_ATTEMPTS: usize = 3;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_START_TIMEOUT: Duration = Duration::from_secs(30);
const READ_STALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelDownloadTarget {
    pub label: String,
    pub url: String,
    pub destination_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelDownloadProgress {
    pub label: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub file_downloaded_bytes: u64,
    pub file_total_bytes: Option<u64>,
    pub percentage: f64,
    pub elapsed_ms: u64,
    pub bytes_per_second: f64,
    pub file_elapsed_ms: u64,
    pub file_bytes_per_second: f64,
    pub retry_count: u32,
    pub file_retry_count: u32,
    pub file_complete: bool,
    pub complete: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct DownloadProgressMetrics {
    elapsed_ms: u64,
    bytes_per_second: f64,
    file_elapsed_ms: u64,
    file_bytes_per_second: f64,
    retry_count: u32,
    file_retry_count: u32,
    file_complete: bool,
    complete: bool,
}

#[derive(Debug, Clone, Copy)]
struct FileDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    network_downloaded_bytes: u64,
    elapsed: Duration,
    retry_count: u32,
}

#[derive(Debug, Clone, Copy)]
struct FileDownloadReport {
    final_size: u64,
    network_downloaded_bytes: u64,
    elapsed: Duration,
    retry_count: u32,
}

pub fn download_llm_model_files(
    targets: Vec<LlmModelDownloadTarget>,
    on_progress: impl FnMut(LlmModelDownloadProgress),
    is_cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    let runtime = Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(download_llm_model_files_async(
        targets,
        on_progress,
        is_cancelled,
    ))
}

async fn download_llm_model_files_async(
    targets: Vec<LlmModelDownloadTarget>,
    mut on_progress: impl FnMut(LlmModelDownloadProgress),
    is_cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    if targets.is_empty() {
        return Ok(());
    }

    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;
    let download_started_at = Instant::now();
    let mut file_totals = Vec::with_capacity(targets.len());

    for target in &targets {
        let destination = Path::new(&target.destination_path);
        if destination.exists() && is_valid_gguf_download(destination) {
            file_totals.push(file_size(destination));
        } else {
            file_totals.push(fetch_content_length(&client, &target.url).await);
        }
    }

    let total_bytes = if file_totals.iter().all(Option::is_some) {
        let total = file_totals.iter().flatten().copied().sum::<u64>();
        (total > 0).then_some(total)
    } else {
        None
    };

    let mut downloaded_so_far = targets
        .iter()
        .zip(&file_totals)
        .map(|(target, total)| {
            let existing = existing_download_bytes(Path::new(&target.destination_path));
            total.map_or(existing, |value| existing.min(value))
        })
        .sum::<u64>();
    let mut network_downloaded_so_far = 0u64;
    let mut completed_retry_count = 0u32;

    emit_combined_progress(
        "Preparing downloads",
        downloaded_so_far,
        total_bytes,
        0,
        None,
        DownloadProgressMetrics::default(),
        &mut on_progress,
    );

    for (index, target) in targets.iter().enumerate() {
        if is_cancelled() {
            return Err("Download cancelled".to_string());
        }

        let destination = PathBuf::from(&target.destination_path);
        if destination.exists() && is_valid_gguf_download(&destination) {
            continue;
        }

        let existing_for_file = existing_download_bytes(&destination);
        let bytes_before_file = downloaded_so_far.saturating_sub(existing_for_file);
        let expected_file_total = file_totals.get(index).copied().flatten();

        let file_report = download_llm_model_file(
            &client,
            target,
            &destination,
            expected_file_total,
            |file_progress| {
                let overall_downloaded =
                    bytes_before_file.saturating_add(file_progress.downloaded_bytes);
                let overall_total = total_bytes.or_else(|| {
                    let mut known_total = 0u64;
                    for (known_index, total) in file_totals.iter().enumerate() {
                        known_total += if known_index == index {
                            file_progress.total_bytes.unwrap_or(0)
                        } else {
                            total.unwrap_or(0)
                        };
                    }
                    (known_total > 0).then_some(known_total)
                });
                emit_combined_progress(
                    &target.label,
                    overall_downloaded,
                    overall_total,
                    file_progress.downloaded_bytes,
                    file_progress.total_bytes,
                    progress_metrics(
                        download_started_at.elapsed(),
                        network_downloaded_so_far
                            .saturating_add(file_progress.network_downloaded_bytes),
                        file_progress.elapsed,
                        file_progress.network_downloaded_bytes,
                        completed_retry_count.saturating_add(file_progress.retry_count),
                        file_progress.retry_count,
                        false,
                        false,
                    ),
                    &mut on_progress,
                );
            },
            &is_cancelled,
        )
        .await?;

        downloaded_so_far = bytes_before_file.saturating_add(file_report.final_size);
        network_downloaded_so_far =
            network_downloaded_so_far.saturating_add(file_report.network_downloaded_bytes);
        completed_retry_count = completed_retry_count.saturating_add(file_report.retry_count);

        emit_combined_progress(
            &target.label,
            downloaded_so_far,
            total_bytes.or(Some(downloaded_so_far)),
            file_report.final_size,
            expected_file_total.or(Some(file_report.final_size)),
            progress_metrics(
                download_started_at.elapsed(),
                network_downloaded_so_far,
                file_report.elapsed,
                file_report.network_downloaded_bytes,
                completed_retry_count,
                file_report.retry_count,
                true,
                false,
            ),
            &mut on_progress,
        );
    }

    emit_combined_progress(
        "Complete",
        total_bytes.unwrap_or(downloaded_so_far),
        total_bytes.or(Some(downloaded_so_far)),
        0,
        None,
        progress_metrics(
            download_started_at.elapsed(),
            network_downloaded_so_far,
            Duration::ZERO,
            0,
            completed_retry_count,
            0,
            false,
            true,
        ),
        &mut on_progress,
    );

    Ok(())
}

async fn download_llm_model_file(
    client: &Client,
    target: &LlmModelDownloadTarget,
    destination: &Path,
    expected_file_total: Option<u64>,
    mut on_progress: impl FnMut(FileDownloadProgress),
    is_cancelled: &impl Fn() -> bool,
) -> Result<FileDownloadReport, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("Invalid destination path: {}", destination.display()))?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;

    let tmp_path = tmp_path_for(destination);
    let file_started_at = Instant::now();
    let mut network_downloaded_bytes = 0u64;
    let mut retry_count = 0u32;

    for attempt in 1..=MAX_ATTEMPTS {
        if is_cancelled() {
            return Err("Download cancelled".to_string());
        }

        let mut resume_from = valid_resume_bytes(&tmp_path)?;
        let mut response = match request_model(client, &target.url, resume_from).await {
            Ok(response) => response,
            Err(err) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(format!("Failed to download {}: {}", target.label, err));
                }
                retry_count = retry_count.saturating_add(1);
                continue;
            }
        };

        if resume_from > 0 && response.status() == reqwest::StatusCode::OK {
            let _ = fs::remove_file(&tmp_path);
            resume_from = 0;
            response = match request_model(client, &target.url, 0).await {
                Ok(response) => response,
                Err(err) => {
                    if attempt == MAX_ATTEMPTS {
                        return Err(format!("Failed to download {}: {}", target.label, err));
                    }
                    retry_count = retry_count.saturating_add(1);
                    continue;
                }
            };
        }

        if !response.status().is_success() {
            if attempt == MAX_ATTEMPTS {
                return Err(format!(
                    "Failed to download {}: HTTP {}",
                    target.label,
                    response.status()
                ));
            }
            retry_count = retry_count.saturating_add(1);
            continue;
        }

        let file_total = content_total(&response, resume_from).or(expected_file_total);
        if let Some(total) = file_total {
            if total <= resume_from {
                let _ = fs::remove_file(&tmp_path);
                retry_count = retry_count.saturating_add(1);
                continue;
            }
        }

        let append = resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&tmp_path)
            .map_err(|err| err.to_string())?;

        let mut downloaded = resume_from;
        let mut first_bytes = if resume_from == 0 {
            Vec::with_capacity(4)
        } else {
            Vec::new()
        };
        let mut last_progress = Instant::now();
        let mut retry_attempt = false;

        on_progress(FileDownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: file_total,
            network_downloaded_bytes,
            elapsed: file_started_at.elapsed(),
            retry_count,
        });

        loop {
            if is_cancelled() {
                file.flush().ok();
                return Err("Download cancelled".to_string());
            }

            let chunk = match timeout(READ_STALL_TIMEOUT, response.chunk()).await {
                Ok(Ok(chunk)) => chunk,
                Ok(Err(err)) => {
                    file.flush().ok();
                    if attempt == MAX_ATTEMPTS {
                        return Err(format!("Failed to download {}: {}", target.label, err));
                    }
                    retry_count = retry_count.saturating_add(1);
                    retry_attempt = true;
                    break;
                }
                Err(_) => {
                    file.flush().ok();
                    if attempt == MAX_ATTEMPTS {
                        return Err(format!(
                            "Failed to download {}: stalled for {} seconds",
                            target.label,
                            READ_STALL_TIMEOUT.as_secs()
                        ));
                    }
                    retry_count = retry_count.saturating_add(1);
                    retry_attempt = true;
                    break;
                }
            };
            let Some(chunk) = chunk else {
                break;
            };

            if downloaded < 4 {
                let needed = 4usize.saturating_sub(first_bytes.len());
                first_bytes.extend_from_slice(&chunk[..chunk.len().min(needed)]);
                if first_bytes.len() == 4 && !is_gguf_header(&first_bytes) {
                    let _ = fs::remove_file(&tmp_path);
                    return Err("Downloaded file is not GGUF".to_string());
                }
            }

            file.write_all(&chunk).map_err(|err| err.to_string())?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            network_downloaded_bytes = network_downloaded_bytes.saturating_add(chunk.len() as u64);

            if last_progress.elapsed() >= PROGRESS_INTERVAL {
                on_progress(FileDownloadProgress {
                    downloaded_bytes: downloaded,
                    total_bytes: file_total,
                    network_downloaded_bytes,
                    elapsed: file_started_at.elapsed(),
                    retry_count,
                });
                last_progress = Instant::now();
            }
        }

        if retry_attempt {
            drop(file);
            continue;
        }

        file.flush().map_err(|err| err.to_string())?;
        drop(file);

        on_progress(FileDownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: file_total,
            network_downloaded_bytes,
            elapsed: file_started_at.elapsed(),
            retry_count,
        });

        if let Some(total) = file_total {
            if downloaded < total {
                if attempt == MAX_ATTEMPTS {
                    return Err(format!(
                        "Download incomplete: expected {total} bytes, got {downloaded}"
                    ));
                }
                retry_count = retry_count.saturating_add(1);
                continue;
            }
        }

        if downloaded < MIN_GGUF_BYTES {
            let _ = fs::remove_file(&tmp_path);
            return Err("Downloaded file too small".to_string());
        }

        if !looks_like_gguf(&tmp_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err("Downloaded file is not GGUF".to_string());
        }

        if destination.exists() {
            fs::remove_file(destination).map_err(|err| err.to_string())?;
        }
        fs::rename(&tmp_path, destination).map_err(|err| err.to_string())?;

        let final_size = file_size(destination).unwrap_or(downloaded);
        if final_size != downloaded {
            let _ = fs::remove_file(destination);
            return Err(format!(
                "Downloaded file size mismatch ({final_size} != {downloaded})"
            ));
        }

        return Ok(FileDownloadReport {
            final_size,
            network_downloaded_bytes,
            elapsed: file_started_at.elapsed(),
            retry_count,
        });
    }

    Err("Failed to download model".to_string())
}

async fn request_model(client: &Client, url: &str, resume_from: u64) -> Result<Response, String> {
    let mut request = client.get(url);
    if resume_from > 0 {
        request = request.header(RANGE, format!("bytes={resume_from}-"));
    }
    timeout(RESPONSE_START_TIMEOUT, request.send())
        .await
        .map_err(|_| {
            format!(
                "request did not receive a response within {} seconds",
                RESPONSE_START_TIMEOUT.as_secs()
            )
        })?
        .map_err(|err| err.to_string())
}

async fn fetch_content_length(client: &Client, url: &str) -> Option<u64> {
    let response = timeout(RESPONSE_START_TIMEOUT, client.head(url).send())
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response
        .content_length()
        .or_else(|| {
            response
                .headers()
                .get("Content-Length")?
                .to_str()
                .ok()?
                .parse()
                .ok()
        })
        .filter(|value| *value > 0)
}

fn content_total(response: &Response, resume_from: u64) -> Option<u64> {
    let content_range_total = response
        .headers()
        .get("Content-Range")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range_total);
    let content_length = response.content_length().filter(|value| *value > 0);

    content_range_total.or_else(|| {
        if resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            content_length.map(|value| value.saturating_add(resume_from))
        } else {
            content_length
        }
    })
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, total) = value.rsplit_once('/')?;
    if total == "*" {
        None
    } else {
        total.parse().ok()
    }
}

fn emit_combined_progress(
    label: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    file_downloaded_bytes: u64,
    file_total_bytes: Option<u64>,
    metrics: DownloadProgressMetrics,
    on_progress: &mut impl FnMut(LlmModelDownloadProgress),
) {
    let percentage = total_bytes
        .filter(|value| *value > 0)
        .map(|total| ((downloaded_bytes as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
        .unwrap_or(0.0);

    on_progress(LlmModelDownloadProgress {
        label: label.to_string(),
        downloaded_bytes,
        total_bytes,
        file_downloaded_bytes,
        file_total_bytes,
        percentage,
        elapsed_ms: metrics.elapsed_ms,
        bytes_per_second: metrics.bytes_per_second,
        file_elapsed_ms: metrics.file_elapsed_ms,
        file_bytes_per_second: metrics.file_bytes_per_second,
        retry_count: metrics.retry_count,
        file_retry_count: metrics.file_retry_count,
        file_complete: metrics.file_complete,
        complete: metrics.complete,
    });
}

fn progress_metrics(
    elapsed: Duration,
    downloaded_bytes: u64,
    file_elapsed: Duration,
    file_downloaded_bytes: u64,
    retry_count: u32,
    file_retry_count: u32,
    file_complete: bool,
    complete: bool,
) -> DownloadProgressMetrics {
    DownloadProgressMetrics {
        elapsed_ms: duration_ms(elapsed),
        bytes_per_second: bytes_per_second(downloaded_bytes, elapsed),
        file_elapsed_ms: duration_ms(file_elapsed),
        file_bytes_per_second: bytes_per_second(file_downloaded_bytes, file_elapsed),
        retry_count,
        file_retry_count,
        file_complete,
        complete,
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn bytes_per_second(bytes: u64, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64();
    if seconds > 0.0 {
        bytes as f64 / seconds
    } else {
        0.0
    }
}

fn existing_download_bytes(destination: &Path) -> u64 {
    if destination.exists() {
        return if is_valid_gguf_download(destination) {
            file_size(destination).unwrap_or(0)
        } else {
            0
        };
    }
    let tmp_path = tmp_path_for(destination);
    valid_resume_bytes(&tmp_path).unwrap_or(0)
}

fn valid_resume_bytes(tmp_path: &Path) -> Result<u64, String> {
    if !tmp_path.exists() {
        return Ok(0);
    }

    let size = file_size(tmp_path).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(tmp_path);
        return Ok(0);
    }

    if size < 4 || !looks_like_gguf(tmp_path) {
        let _ = fs::remove_file(tmp_path);
        return Ok(0);
    }

    Ok(size)
}

fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|metadata| metadata.len())
}

fn tmp_path_for(destination: &Path) -> PathBuf {
    PathBuf::from(format!("{}.tmp", destination.display()))
}

fn looks_like_gguf(path: &Path) -> bool {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut header = [0u8; 4];
    file.read_exact(&mut header).is_ok() && is_gguf_header(&header)
}

fn is_gguf_header(bytes: &[u8]) -> bool {
    bytes == b"GGUF"
}

fn is_valid_gguf_download(path: &Path) -> bool {
    file_size(path).is_some_and(|size| size >= MIN_GGUF_BYTES) && looks_like_gguf(path)
}
