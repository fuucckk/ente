import 'dart:async';
import 'dart:convert';
import "dart:io";

import "package:chewie/chewie.dart";
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:logging/logging.dart";
import "package:media_extension/media_extension_action_types.dart";
import "package:photo_manager/photo_manager.dart";
import "package:photo_manager_image_provider/photo_manager_image_provider.dart";
import "package:photo_view/photo_view.dart";
import "package:photos/services/app_lifecycle_service.dart";
import "package:photos/utils/exif_util.dart";
import "package:receive_sharing_intent/receive_sharing_intent.dart";
import "package:video_player/video_player.dart";

class FileViewer extends StatefulWidget {
  final SharedMediaFile? sharedMediaFile;
  const FileViewer({super.key, this.sharedMediaFile});

  @override
  State<StatefulWidget> createState() {
    return FileViewerState();
  }
}

class FileViewerState extends State<FileViewer> {
  final action = AppLifecycleService.instance.mediaExtensionAction;
  ChewieController? controller;
  VideoPlayerController? videoController;
  final Logger _logger = Logger("FileViewer");
  double? aspectRatio;
  Future<AssetEntity?>? mediaStoreAssetFuture;
  bool get _isExternalView =>
      widget.sharedMediaFile == null &&
      action.action == IntentAction.view &&
      (action.type == MediaType.image || action.type == MediaType.video);

  Widget _boundedPhotoView(ImageProvider imageProvider) {
    return PhotoView(
      imageProvider: imageProvider,
      filterQuality: FilterQuality.high,
      initialScale: PhotoViewComputedScale.contained,
      minScale: PhotoViewComputedScale.contained,
      maxScale: PhotoViewComputedScale.covered * 3.0,
      strictScale: true,
    );
  }

  @override
  void initState() {
    _logger.info("Initializing FileViewer");
    super.initState();
    if (action.type == MediaType.video ||
        widget.sharedMediaFile?.type == SharedMediaType.video) {
      _initializeVideoController();
    } else if (action.type == MediaType.image) {
      mediaStoreAssetFuture = _loadMediaStoreAsset(action.data);
    }
  }

  Future<void> _initializeVideoController() async {
    await _fetchAspectRatio();
    initController();
  }

  Future<void> _fetchAspectRatio() async {
    try {
      final videoPath = widget.sharedMediaFile?.path ?? action.data;
      if (videoPath == null) {
        _logger.warning("Video path is null, using default aspect ratio");
        aspectRatio = 16 / 9;
        return;
      }

      final videoFile = File(videoPath);
      if (!await videoFile.exists()) {
        _logger
            .warning("Video file does not exist, using default aspect ratio");
        aspectRatio = 16 / 9;
        return;
      }

      final videoProps = await getVideoPropsAsync(videoFile);
      if (videoProps != null &&
          videoProps.width != null &&
          videoProps.height != null &&
          videoProps.height != 0) {
        aspectRatio = videoProps.width! / videoProps.height!;
        _logger.info("Fetched video aspect ratio: $aspectRatio");
      } else {
        _logger.warning(
          "Could not get video dimensions, using default aspect ratio",
        );
        aspectRatio = 16 / 9;
      }
    } catch (e) {
      _logger.severe("Error fetching video aspect ratio: $e");
      aspectRatio = 16 / 9;
    }
  }

  @override
  void dispose() {
    videoController?.dispose();
    controller?.dispose();
    super.dispose();
  }

  void initController() async {
    videoController = VideoPlayerController.contentUri(
      widget.sharedMediaFile?.path != null
          ? Uri.parse(widget.sharedMediaFile!.path)
          : Uri.parse(action.data!),
    );
    controller = ChewieController(
      videoPlayerController: videoController!,
      autoInitialize: true,
      aspectRatio: aspectRatio ?? 16 / 9,
      autoPlay: true,
      looping: true,
      showOptions: false,
      materialProgressColors: ChewieProgressColors(
        playedColor: const Color.fromRGBO(45, 194, 98, 1.0),
        handleColor: Colors.white,
        bufferedColor: Colors.white,
      ),
    );
    controller!.addListener(() {
      if (!controller!.isFullScreen) {
        SystemChrome.setPreferredOrientations(
          [DeviceOrientation.portraitUp],
        );
      }
    });
    if (mounted) {
      setState(() {});
    }
  }

  Future<AssetEntity?>? _loadMediaStoreAsset(String? data) {
    final uri = data == null ? null : Uri.tryParse(data);
    final id = uri == null ? null : _mediaStoreAssetId(uri);
    if (id == null) {
      return null;
    }
    return AssetEntity.fromId(id);
  }

  String? _mediaStoreAssetId(Uri uri) {
    if (uri.scheme != "content") {
      return null;
    }
    if (uri.authority == "media") {
      final mediaSegmentIndex = uri.pathSegments.lastIndexOf("media");
      if (mediaSegmentIndex >= 0 &&
          mediaSegmentIndex < uri.pathSegments.length - 1) {
        return uri.pathSegments[mediaSegmentIndex + 1];
      }
    }
    if (uri.authority == "com.android.providers.media.documents" &&
        uri.pathSegments.isNotEmpty) {
      final documentId = uri.pathSegments.last;
      final id = documentId.split(":").last;
      if (id.isNotEmpty) {
        return id;
      }
    }
    return null;
  }

  Widget _buildImageViewer() {
    final sharedMediaPath = widget.sharedMediaFile?.path;
    if (sharedMediaPath != null) {
      return _boundedPhotoView(Image.file(File(sharedMediaPath)).image);
    }

    final data = action.data;
    if (data == null) {
      _logger.severe("image data is null");
      return const Icon(Icons.error);
    }

    final uri = Uri.tryParse(data);
    if (uri?.scheme == "file") {
      return _boundedPhotoView(FileImage(File(uri!.toFilePath())));
    }

    final assetFuture = mediaStoreAssetFuture;
    if (assetFuture != null) {
      return FutureBuilder<AssetEntity?>(
        future: assetFuture,
        builder: (context, snapshot) {
          final asset = snapshot.data;
          if (asset == null) {
            if (snapshot.connectionState == ConnectionState.done) {
              _logger.severe("failed to resolve media store image $data");
              return const Icon(Icons.error);
            }
            return const CircularProgressIndicator();
          }
          return _boundedPhotoView(AssetEntityImageProvider(asset));
        },
      );
    }

    return _boundedPhotoView(MemoryImage(base64Decode(data)));
  }

  @override
  Widget build(BuildContext context) {
    _logger.info("Building FileViewer");
    final scaffold = Scaffold(
      appBar: AppBar(
        leading: IconButton(
          onPressed: _closeViewer,
          icon: const Icon(Icons.arrow_back),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: Center(
              child: (() {
                if (action.type == MediaType.image ||
                    widget.sharedMediaFile?.type == SharedMediaType.image) {
                  return _buildImageViewer();
                } else if (action.type == MediaType.video ||
                    widget.sharedMediaFile?.type == SharedMediaType.video) {
                  return controller != null
                      ? Chewie(controller: controller!)
                      : const CircularProgressIndicator();
                } else {
                  _logger.severe(
                    'unsupported file type ${action.type} or ${widget.sharedMediaFile?.type}',
                  );
                  return const Icon(Icons.error);
                }
              })(),
            ),
          ),
        ],
      ),
    );
    if (!_isExternalView) {
      return scaffold;
    }
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) {
          unawaited(_closeViewer());
        }
      },
      child: scaffold,
    );
  }

  Future<void> _closeViewer() async {
    await SystemChannels.platform.invokeMethod('SystemNavigator.pop');
  }
}
