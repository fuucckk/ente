import { Canceler } from "axios";
import { isDesktop } from "ente-base/app";
import { createComlinkCryptoWorker } from "ente-base/crypto";
import { type CryptoWorker } from "ente-base/crypto/worker";
import { lowercaseExtension, nameAndExtension } from "ente-base/file-name";
import type { PublicAlbumsCredentials } from "ente-base/http";
import log from "ente-base/log";
import { ComlinkWorker } from "ente-base/worker/comlink-worker";
import {
    RANDOM_PERCENTAGE_PROGRESS_FOR_PUT,
    markUploadedAndObtainProcessableItem,
    shouldDisableCFUploadProxy,
    type ClusteredUploadItem,
    type UploadPhase,
    type UploadResult,
    type UploadableUploadItem,
} from "ente-gallery/services/upload";
import {
    metadataJSONMapKeyForJSON,
    tryParseTakeoutMetadataJSON,
    type ParsedMetadataJSON,
} from "ente-gallery/services/upload/takeout";
import UploadService, {
    areLivePhotoAssets,
    upload,
    uploadItemFileName,
    type PotentialLivePhotoAsset,
    type UploadAsset,
} from "ente-gallery/services/upload/upload-service";
import { processVideoNewUpload } from "ente-gallery/services/video";
import type { Collection } from "ente-media/collection";
import {
    decryptFile,
    type EncryptedEnteFile,
    type EnteFile,
} from "ente-media/file";
import type { ParsedMetadata } from "ente-media/file-metadata";
import { FileType } from "ente-media/file-type";
import { potentialFileTypeFromExtension } from "ente-media/live-photo";
import { getLocalFiles } from "ente-new/photos/services/files";
import { indexNewUpload } from "ente-new/photos/services/ml";
import { CustomError } from "ente-shared/error";
import { wait } from "ente-utils/promise";
import {
    getLocalPublicFiles,
    getPublicCollectionUID,
} from "services/publicCollectionService";
import watcher from "services/watch";
import { getUserOwnedFiles } from "utils/file";

export type FileID = number;

export type PercentageUploaded = number;
/* localID => fileName */
export type UploadFileNames = Map<FileID, string>;

export interface UploadCounter {
    finished: number;
    total: number;
}

export interface InProgressUpload {
    localFileID: FileID;
    progress: PercentageUploaded;
}

export interface FinishedUpload {
    localFileID: FileID;
    result: UploadResult;
}

export type InProgressUploads = Map<FileID, PercentageUploaded>;

export type FinishedUploads = Map<FileID, UploadResult>;

export type SegregatedFinishedUploads = Map<UploadResult, FileID[]>;

export interface ProgressUpdater {
    setPercentComplete: React.Dispatch<React.SetStateAction<number>>;
    setUploadCounter: React.Dispatch<React.SetStateAction<UploadCounter>>;
    setUploadPhase: (phase: UploadPhase) => void;
    setInProgressUploads: React.Dispatch<
        React.SetStateAction<InProgressUpload[]>
    >;
    setFinishedUploads: React.Dispatch<
        React.SetStateAction<SegregatedFinishedUploads>
    >;
    setUploadFilenames: React.Dispatch<React.SetStateAction<UploadFileNames>>;
    setHasLivePhotos: React.Dispatch<React.SetStateAction<boolean>>;
    setUploadProgressView: React.Dispatch<React.SetStateAction<boolean>>;
}

/** The number of uploads to process in parallel. */
const maxConcurrentUploads = 4;

export type UploadItemWithCollection = UploadAsset & {
    localID: number;
    collectionID: number;
};

interface UploadCancelStatus {
    value: boolean;
}

class UploadCancelService {
    private shouldUploadBeCancelled: UploadCancelStatus = { value: false };

    reset() {
        this.shouldUploadBeCancelled.value = false;
    }

    requestUploadCancelation() {
        this.shouldUploadBeCancelled.value = true;
    }

    isUploadCancelationRequested(): boolean {
        return this.shouldUploadBeCancelled.value;
    }
}

const uploadCancelService = new UploadCancelService();

class UIService {
    private progressUpdater: ProgressUpdater;

    // UPLOAD LEVEL STATES
    private uploadPhase: UploadPhase = "preparing";
    private filenames = new Map<number, string>();
    private hasLivePhoto: boolean = false;
    private uploadProgressView: boolean = false;

    // STAGE LEVEL STATES
    private perFileProgress: number;
    private filesUploadedCount: number;
    private totalFilesCount: number;
    private inProgressUploads: InProgressUploads = new Map();
    private finishedUploads: FinishedUploads = new Map();

    init(progressUpdater: ProgressUpdater) {
        this.progressUpdater = progressUpdater;
        this.progressUpdater.setUploadPhase(this.uploadPhase);
        this.progressUpdater.setUploadFilenames(this.filenames);
        this.progressUpdater.setHasLivePhotos(this.hasLivePhoto);
        this.progressUpdater.setUploadProgressView(this.uploadProgressView);
        this.progressUpdater.setUploadCounter({
            finished: this.filesUploadedCount,
            total: this.totalFilesCount,
        });
        this.progressUpdater.setInProgressUploads(
            convertInProgressUploadsToList(this.inProgressUploads),
        );
        this.progressUpdater.setFinishedUploads(
            groupByResult(this.finishedUploads),
        );
    }

    reset(count = 0) {
        this.setTotalFileCount(count);
        this.filesUploadedCount = 0;
        this.inProgressUploads = new Map<number, number>();
        this.finishedUploads = new Map<number, UploadResult>();
        this.updateProgressBarUI();
    }

    setTotalFileCount(count: number) {
        this.totalFilesCount = count;
        if (count > 0) {
            this.perFileProgress = 100 / this.totalFilesCount;
        } else {
            this.perFileProgress = 0;
        }
    }

    setFileProgress(key: number, progress: number) {
        this.inProgressUploads.set(key, progress);
        this.updateProgressBarUI();
    }

    setUploadPhase(phase: UploadPhase) {
        this.uploadPhase = phase;
        this.progressUpdater.setUploadPhase(phase);
    }

    setFiles(files: { localID: number; fileName: string }[]) {
        const filenames = new Map(files.map((f) => [f.localID, f.fileName]));
        this.filenames = filenames;
        this.progressUpdater.setUploadFilenames(filenames);
    }

    setHasLivePhoto(hasLivePhoto: boolean) {
        this.hasLivePhoto = hasLivePhoto;
        this.progressUpdater.setHasLivePhotos(hasLivePhoto);
    }

    setUploadProgressView(uploadProgressView: boolean) {
        this.uploadProgressView = uploadProgressView;
        this.progressUpdater.setUploadProgressView(uploadProgressView);
    }

    increaseFileUploaded() {
        this.filesUploadedCount++;
        this.updateProgressBarUI();
    }

    moveFileToResultList(key: number, uploadResult: UploadResult) {
        this.finishedUploads.set(key, uploadResult);
        this.inProgressUploads.delete(key);
        this.updateProgressBarUI();
    }

    hasFilesInResultList() {
        return this.finishedUploads.size > 0;
    }

    private updateProgressBarUI() {
        const {
            setPercentComplete,
            setUploadCounter,
            setInProgressUploads,
            setFinishedUploads,
        } = this.progressUpdater;
        setUploadCounter({
            finished: this.filesUploadedCount,
            total: this.totalFilesCount,
        });
        let percentComplete =
            this.perFileProgress *
            (this.finishedUploads.size || this.filesUploadedCount);
        if (this.inProgressUploads) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for (const [_, progress] of this.inProgressUploads) {
                // filter  negative indicator values during percentComplete calculation
                if (progress < 0) {
                    continue;
                }
                percentComplete += (this.perFileProgress * progress) / 100;
            }
        }

        setPercentComplete(percentComplete);
        setInProgressUploads(
            convertInProgressUploadsToList(this.inProgressUploads),
        );
        setFinishedUploads(groupByResult(this.finishedUploads));
    }

    trackUploadProgress(
        fileLocalID: number,
        percentPerPart = RANDOM_PERCENTAGE_PROGRESS_FOR_PUT(),
        index = 0,
    ) {
        const cancel: { exec: Canceler } = { exec: () => {} };
        const cancelTimedOutRequest = () => cancel.exec("Request timed out");

        const cancelCancelledUploadRequest = () =>
            cancel.exec(CustomError.UPLOAD_CANCELLED);

        let timeout = null;
        const resetTimeout = () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            timeout = setTimeout(cancelTimedOutRequest, 30 * 1000 /* 30 sec */);
        };
        return {
            cancel,
            onUploadProgress: (event) => {
                this.inProgressUploads.set(
                    fileLocalID,
                    Math.min(
                        Math.round(
                            percentPerPart * index +
                                (percentPerPart * event.loaded) / event.total,
                        ),
                        98,
                    ),
                );
                this.updateProgressBarUI();
                if (event.loaded === event.total) {
                    clearTimeout(timeout);
                } else {
                    resetTimeout();
                }
                if (uploadCancelService.isUploadCancelationRequested()) {
                    cancelCancelledUploadRequest();
                }
            },
        };
    }
}

function convertInProgressUploadsToList(inProgressUploads) {
    return [...inProgressUploads.entries()].map(
        ([localFileID, progress]) =>
            ({ localFileID, progress }) as InProgressUpload,
    );
}

const groupByResult = (finishedUploads: FinishedUploads) => {
    const groups: SegregatedFinishedUploads = new Map();
    for (const [localID, result] of finishedUploads) {
        if (!groups.has(result)) groups.set(result, []);
        groups.get(result).push(localID);
    }
    return groups;
};

class UploadManager {
    private comlinkCryptoWorkers = new Array<
        ComlinkWorker<typeof CryptoWorker>
    >(maxConcurrentUploads);
    private parsedMetadataJSONMap: Map<string, ParsedMetadataJSON>;
    private itemsToBeUploaded: ClusteredUploadItem[];
    private failedItems: ClusteredUploadItem[];
    private existingFiles: EnteFile[];
    private onUploadFile: (file: EnteFile) => void;
    private collections: Map<number, Collection>;
    private uploadInProgress: boolean;
    private publicAlbumsCredentials: PublicAlbumsCredentials | undefined;
    private uploaderName: string;
    private uiService: UIService;

    constructor() {
        this.uiService = new UIService();
    }

    public async init(
        progressUpdater: ProgressUpdater,
        onUploadFile: (file: EnteFile) => void,
        publicAlbumsCredentials: PublicAlbumsCredentials | undefined,
    ) {
        this.uiService.init(progressUpdater);
        UploadService.init(publicAlbumsCredentials);
        this.onUploadFile = onUploadFile;
        this.publicAlbumsCredentials = publicAlbumsCredentials;
    }

    logout() {
        // TODO: Consolidate state in one place instead of spreading it.
        UploadService.logout();
    }

    public isUploadRunning() {
        return this.uploadInProgress;
    }

    private resetState() {
        this.itemsToBeUploaded = [];
        this.failedItems = [];
        this.parsedMetadataJSONMap = new Map<string, ParsedMetadataJSON>();

        this.uploaderName = null;
    }

    public prepareForNewUpload() {
        this.resetState();
        this.uiService.reset();
        uploadCancelService.reset();
        this.uiService.setUploadPhase("preparing");
    }

    showUploadProgressDialog() {
        this.uiService.setUploadProgressView(true);
    }

    /**
     * Upload files
     *
     * This method waits for all the files to get uploaded (successfully or
     * unsuccessfully) before returning.
     *
     * It is an error to call this method when there is already an in-progress
     * upload.
     *
     * @param itemsWithCollection The items to upload, each paired with the id
     * of the collection that they should be uploaded into.
     *
     * @returns `true` if at least one file was processed
     */
    public async uploadItems(
        itemsWithCollection: UploadItemWithCollection[],
        collections: Collection[],
        uploaderName?: string,
    ) {
        if (this.uploadInProgress)
            throw new Error("Cannot run multiple uploads at once");

        log.info(`Uploading ${itemsWithCollection.length} files`);
        this.uploadInProgress = true;
        this.uploaderName = uploaderName;

        const logInterval = setInterval(logAboutMemoryPressureIfNeeded, 1000);

        try {
            await this.updateExistingFilesAndCollections(collections);

            const namedItems = itemsWithCollection.map(
                makeUploadItemWithCollectionIDAndName,
            );

            this.uiService.setFiles(namedItems);

            const [metadataItems, mediaItems] =
                splitMetadataAndMediaItems(namedItems);

            if (metadataItems.length) {
                this.uiService.setUploadPhase("readingMetadata");
                await this.parseMetadataJSONFiles(metadataItems);
            }

            if (mediaItems.length) {
                const clusteredMediaItems = await clusterLivePhotos(
                    mediaItems,
                    this.parsedMetadataJSONMap,
                );

                this.abortIfCancelled();

                // Live photos might've been clustered together, reset the list
                // of files to reflect that.
                this.uiService.setFiles(clusteredMediaItems);

                this.uiService.setHasLivePhoto(
                    mediaItems.length != clusteredMediaItems.length,
                );

                await this.uploadMediaItems(clusteredMediaItems);
            }
        } catch (e) {
            if (e.message != CustomError.UPLOAD_CANCELLED) {
                log.error("Upload failed", e);
                throw e;
            }
        } finally {
            this.uiService.setUploadPhase("done");
            void globalThis.electron?.clearPendingUploads();
            for (let i = 0; i < maxConcurrentUploads; i++) {
                this.comlinkCryptoWorkers[i]?.terminate();
            }
            this.uploadInProgress = false;
            clearInterval(logInterval);
        }

        return this.uiService.hasFilesInResultList();
    }

    /**
     * Upload a single file to the given collection.
     *
     * @param file A web {@link File} object representing the file to upload.
     *
     * @param collection The {@link Collection} in which the file should be
     * added.
     *
     * @param sourceEnteFile The {@link EnteFile} from which the file being
     * uploaded has been derived. This is used to extract and reassociated
     * relevant metadata to the newly uploaded file.
     */
    public async uploadFile(
        file: File,
        collection: Collection,
        sourceEnteFile: EnteFile,
    ) {
        const timestamp = sourceEnteFile.metadata.creationTime;
        const dateTime = sourceEnteFile.pubMagicMetadata?.data.dateTime;
        const offset = sourceEnteFile.pubMagicMetadata?.data.offsetTime;

        const creationDate: ParsedMetadata["creationDate"] = dateTime
            ? { timestamp, dateTime, offset }
            : undefined;

        // Fallback to the timestamp if a creationDate could not be constructed.
        const creationTime = creationDate ? undefined : timestamp;

        const item = {
            uploadItem: file,
            localID: 1,
            collectionID: collection.id,
            externalParsedMetadata: { creationDate, creationTime },
        };

        return this.uploadItems([item], [collection]);
    }

    private abortIfCancelled = () => {
        if (uploadCancelService.isUploadCancelationRequested()) {
            throw Error(CustomError.UPLOAD_CANCELLED);
        }
    };

    private async updateExistingFilesAndCollections(collections: Collection[]) {
        if (this.publicAlbumsCredentials) {
            this.existingFiles = await getLocalPublicFiles(
                getPublicCollectionUID(
                    this.publicAlbumsCredentials.accessToken,
                ),
            );
        } else {
            this.existingFiles = getUserOwnedFiles(await getLocalFiles());
        }
        this.collections = new Map(
            collections.map((collection) => [collection.id, collection]),
        );
    }

    private async parseMetadataJSONFiles(
        items: UploadItemWithCollectionIDAndName[],
    ) {
        this.uiService.reset(items.length);

        for (const { uploadItem, fileName, collectionID } of items) {
            this.abortIfCancelled();

            log.info(`Parsing metadata JSON ${fileName}`);
            const metadataJSON = await tryParseTakeoutMetadataJSON(uploadItem!);
            if (metadataJSON) {
                this.parsedMetadataJSONMap.set(
                    metadataJSONMapKeyForJSON(collectionID, fileName),
                    metadataJSON,
                );
                this.uiService.increaseFileUploaded();
            }
        }
    }

    private async uploadMediaItems(mediaItems: ClusteredUploadItem[]) {
        this.itemsToBeUploaded = [...this.itemsToBeUploaded, ...mediaItems];
        this.uiService.reset(mediaItems.length);
        await UploadService.setFileCount(mediaItems.length);
        this.uiService.setUploadPhase("uploading");

        const uploadProcesses = [];
        for (
            let i = 0;
            i < maxConcurrentUploads && this.itemsToBeUploaded.length > 0;
            i++
        ) {
            this.comlinkCryptoWorkers[i] = createComlinkCryptoWorker();
            const worker = await this.comlinkCryptoWorkers[i].remote;
            uploadProcesses.push(this.uploadNextItemInQueue(worker));
        }
        await Promise.all(uploadProcesses);
    }

    private async uploadNextItemInQueue(worker: CryptoWorker) {
        const uiService = this.uiService;

        while (this.itemsToBeUploaded.length > 0) {
            this.abortIfCancelled();
            logAboutMemoryPressureIfNeeded();

            const clusteredItem = this.itemsToBeUploaded.pop();
            const { localID, collectionID } = clusteredItem;
            const collection = this.collections.get(collectionID);
            const uploadableItem = { ...clusteredItem, collection };

            uiService.setFileProgress(localID, 0);
            await wait(0);

            const { uploadResult, uploadedFile } = await upload(
                uploadableItem,
                this.uploaderName,
                this.existingFiles,
                this.parsedMetadataJSONMap,
                worker,
                shouldDisableCFUploadProxy(),
                () => {
                    this.abortIfCancelled();
                },
                (
                    fileLocalID: number,
                    percentPerPart?: number,
                    index?: number,
                ) =>
                    uiService.trackUploadProgress(
                        fileLocalID,
                        percentPerPart,
                        index,
                    ),
            );

            const finalUploadResult = await this.postUploadTask(
                uploadableItem,
                uploadResult,
                uploadedFile,
            );

            this.uiService.moveFileToResultList(localID, finalUploadResult);
            this.uiService.increaseFileUploaded();
            UploadService.reducePendingUploadCount();
        }
    }

    private async postUploadTask(
        uploadableItem: UploadableUploadItem,
        uploadResult: UploadResult,
        uploadedFile: EncryptedEnteFile | EnteFile | undefined,
    ) {
        log.info(`Upload ${uploadableItem.fileName} | ${uploadResult}`);
        try {
            const processableUploadItem =
                await markUploadedAndObtainProcessableItem(uploadableItem);

            let decryptedFile: EnteFile;
            switch (uploadResult) {
                case "failed":
                case "blocked":
                    this.failedItems.push(uploadableItem);
                    break;
                case "alreadyUploaded":
                    decryptedFile = uploadedFile as EnteFile;
                    break;
                case "addedSymlink":
                    decryptedFile = uploadedFile as EnteFile;
                    uploadResult = "uploaded";
                    break;
                case "uploaded":
                case "uploadedWithStaticThumbnail":
                    decryptedFile = await decryptFile(
                        uploadedFile as EncryptedEnteFile,
                        uploadableItem.collection.key,
                    );
                    break;
                case "unsupported":
                case "tooLarge":
                    // no-op
                    break;
                default:
                    throw new Error(`Invalid Upload Result ${uploadResult}`);
            }
            if (
                [
                    "addedSymlink",
                    "uploaded",
                    "uploadedWithStaticThumbnail",
                ].includes(uploadResult)
            ) {
                const uploadItem =
                    uploadableItem.uploadItem ??
                    uploadableItem.livePhotoAssets.image;
                if (
                    uploadItem &&
                    (uploadResult == "uploaded" ||
                        uploadResult == "uploadedWithStaticThumbnail")
                ) {
                    indexNewUpload(decryptedFile, processableUploadItem);
                    processVideoNewUpload(decryptedFile, processableUploadItem);
                }
                this.updateExistingFiles(decryptedFile);
            }
            await this.watchFolderCallback(
                uploadResult,
                uploadableItem,
                uploadedFile as EncryptedEnteFile,
            );
            return uploadResult;
        } catch (e) {
            log.error("Post file upload action failed", e);
            return "failed";
        }
    }

    private async watchFolderCallback(
        fileUploadResult: UploadResult,
        fileWithCollection: ClusteredUploadItem,
        uploadedFile: EncryptedEnteFile,
    ) {
        if (isDesktop) {
            if (watcher.isUploadRunning()) {
                await watcher.onFileUpload(
                    fileUploadResult,
                    fileWithCollection,
                    uploadedFile,
                );
            }
        }
    }

    public cancelRunningUpload() {
        log.info("User cancelled running upload");
        this.uiService.setUploadPhase("cancelling");
        uploadCancelService.requestUploadCancelation();
    }

    public getFailedItemsWithCollections() {
        return {
            items: this.failedItems,
            collections: [...this.collections.values()],
        };
    }

    public getUploaderName() {
        return this.uploaderName;
    }

    private updateExistingFiles(decryptedFile: EnteFile) {
        if (!decryptedFile) {
            throw Error("decrypted file can't be undefined");
        }
        this.existingFiles.push(decryptedFile);
        this.onUploadFile(decryptedFile);
    }

    public shouldAllowNewUpload = () => {
        return !this.uploadInProgress || watcher.isUploadRunning();
    };
}

/**
 * Singleton instance of {@link UploadManager}.
 */
export const uploadManager = new UploadManager();

/**
 * The data operated on by the intermediate stages of the upload.
 *
 * [Note: Intermediate file types during upload]
 *
 * As files progress through stages, they get more and more bits tacked on to
 * them. These types document the journey.
 *
 * - The input is {@link UploadItemWithCollection}. This can either be a new
 *   {@link UploadItemWithCollection}, in which case it'll only have a
 *   {@link localID}, {@link collectionID} and a {@link uploadItem}. Or it could
 *   be a retry, in which case it'll not have a {@link uploadItem} but instead
 *   will have data from a previous stage (concretely, it'll just be a
 *   relabelled {@link ClusteredUploadItem}), like a snake eating its tail.
 *
 * - Immediately we convert it to {@link UploadItemWithCollectionIDAndName}.
 *   This is to mostly systematize what we have, and also attach a
 *   {@link fileName}.
 *
 * - These then get converted to "assets", whereby both parts of a live photo
 *   are combined. This is a {@link ClusteredUploadItem}.
 *
 * - On to the {@link ClusteredUploadItem} we attach the corresponding
 *   {@link collection}, giving us {@link UploadableUploadItem}. This is what
 *   gets queued and then passed to the {@link upload}.
 */
type UploadItemWithCollectionIDAndName = UploadAsset & {
    /** A unique ID for the duration of the upload */
    localID: number;
    /** The ID of the collection to which this file should be uploaded. */
    collectionID: number;
    /**
     * The name of the file.
     *
     * In case of live photos, this'll be the name of the image part.
     */
    fileName: string;
};

const makeUploadItemWithCollectionIDAndName = (
    f: UploadItemWithCollection,
): UploadItemWithCollectionIDAndName => ({
    localID: f.localID!,
    collectionID: f.collectionID!,
    fileName: (f.isLivePhoto
        ? uploadItemFileName(f.livePhotoAssets.image)
        : uploadItemFileName(f.uploadItem))!,
    isLivePhoto: f.isLivePhoto,
    uploadItem: f.uploadItem,
    livePhotoAssets: f.livePhotoAssets,
    externalParsedMetadata: f.externalParsedMetadata,
});

const splitMetadataAndMediaItems = (
    items: UploadItemWithCollectionIDAndName[],
): [
    metadata: UploadItemWithCollectionIDAndName[],
    media: UploadItemWithCollectionIDAndName[],
] =>
    items.reduce(
        ([metadata, media], f) => {
            if (lowercaseExtension(f.fileName) == "json") metadata.push(f);
            else media.push(f);
            return [metadata, media];
        },
        [[], []],
    );

/**
 * Go through the given files, combining any sibling image + video assets into a
 * single live photo when appropriate.
 */
const clusterLivePhotos = async (
    items: UploadItemWithCollectionIDAndName[],
    parsedMetadataJSONMap: Map<string, ParsedMetadataJSON>,
) => {
    const result: ClusteredUploadItem[] = [];
    items
        .sort((f, g) =>
            nameAndExtension(f.fileName)[0].localeCompare(
                nameAndExtension(g.fileName)[0],
            ),
        )
        .sort((f, g) => f.collectionID - g.collectionID);
    let index = 0;
    while (index < items.length - 1) {
        const f = items[index];
        const g = items[index + 1];
        const fFileType = potentialFileTypeFromExtension(f.fileName);
        const gFileType = potentialFileTypeFromExtension(g.fileName);
        const fa: PotentialLivePhotoAsset = {
            fileName: f.fileName,
            fileType: fFileType,
            collectionID: f.collectionID,
            uploadItem: f.uploadItem,
        };
        const ga: PotentialLivePhotoAsset = {
            fileName: g.fileName,
            fileType: gFileType,
            collectionID: g.collectionID,
            uploadItem: g.uploadItem,
        };
        if (await areLivePhotoAssets(fa, ga, parsedMetadataJSONMap)) {
            const [image, video] =
                fFileType == FileType.image ? [f, g] : [g, f];
            result.push({
                localID: f.localID,
                collectionID: f.collectionID,
                fileName: image.fileName,
                isLivePhoto: true,
                livePhotoAssets: {
                    image: image.uploadItem,
                    video: video.uploadItem,
                },
            });
            index += 2;
        } else {
            result.push({ ...f, isLivePhoto: false });
            index += 1;
        }
    }
    if (index === items.length - 1) {
        result.push({ ...items[index], isLivePhoto: false });
    }
    return result;
};

/**
 * Add logs if our usage increases some high water mark. This is solely so that
 * we have some indication in the logs if we get a user report of OOM crashes.
 */
const logAboutMemoryPressureIfNeeded = () => {
    if (!globalThis.electron) return;
    // performance.memory is deprecated in general as a Web standard, and is
    // also not available in the DOM types provided by TypeScript. However, it
    // is the method recommended by the Electron team (see the link about the V8
    // memory cage). The embedded Chromium supports it fine though, we just need
    // to goad TypeScript to accept the type.
    const heapSize = (performance as any).memory.totalJSHeapSize;
    const heapLimit = (performance as any).memory.jsHeapSizeLimit;
    if (heapSize / heapLimit > 0.7) {
        log.info(
            `Memory usage (${heapSize} bytes of ${heapLimit} bytes) exceeds the high water mark`,
        );
    }
};
