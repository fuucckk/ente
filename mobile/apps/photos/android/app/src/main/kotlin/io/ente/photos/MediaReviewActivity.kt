package io.ente.photos

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.MimeTypeMap
import io.flutter.embedding.android.FlutterFragmentActivity
import java.util.Locale

class MediaReviewActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        normalizeReviewIntent(intent)
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        normalizeReviewIntent(intent)
        super.onNewIntent(intent)
        setIntent(intent)
    }

    private fun normalizeReviewIntent(intent: Intent?) {
        val reviewIntent = intent ?: return
        if (reviewIntent.action !in reviewActions) {
            return
        }
        val uri = reviewIntent.data ?: reviewIntent.streamUri
        val type = reviewIntent.type ?: uri?.let { resolveMimeType(it) }
        reviewIntent.action = Intent.ACTION_VIEW
        if (uri != null && type != null) {
            reviewIntent.setDataAndType(uri, type)
        } else if (uri != null) {
            reviewIntent.data = uri
        }
    }

    private fun resolveMimeType(uri: Uri): String? {
        return typeFromContentResolver(uri) ?: typeFromExtension(uri)
    }

    private fun typeFromContentResolver(uri: Uri): String? {
        return try {
            contentResolver.getType(uri)
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }

    private fun typeFromExtension(uri: Uri): String? {
        val extension = uri.lastPathSegment
            ?.substringAfterLast('.', missingDelimiterValue = "")
            ?.lowercase(Locale.ROOT)
            ?.takeIf { it.isNotBlank() }
            ?: return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }

    private val Intent.streamUri: Uri?
        @Suppress("DEPRECATION")
        get() = getParcelableExtra(Intent.EXTRA_STREAM)

    private companion object {
        private const val ACTION_REVIEW = "android.provider.action.REVIEW"
        private const val ACTION_CAMERA_REVIEW = "com.android.camera.action.REVIEW"
        private val reviewActions = setOf(ACTION_REVIEW, ACTION_CAMERA_REVIEW)
    }
}
