package io.ente.ensu.components

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.ente.ensu.designsystem.EnsuColor
import io.ente.ensu.designsystem.EnsuCornerRadius
import io.ente.ensu.designsystem.HugeIcons
import io.ente.ensu.utils.rememberEnsuHaptics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun ImageAttachmentThumbnail(
    path: String?,
    contentDescription: String?,
    width: Dp,
    height: Dp,
    modifier: Modifier = Modifier,
    isUploading: Boolean = false,
    onDelete: (() -> Unit)? = null,
    onClick: (() -> Unit)? = null
) {
    val density = LocalDensity.current
    val targetWidthPx = with(density) { width.roundToPx() }
    val targetHeightPx = with(density) { height.roundToPx() }
    val bitmap by produceState<ImageBitmap?>(initialValue = null, path, targetWidthPx, targetHeightPx) {
        value = decodeSampledImage(path, targetWidthPx, targetHeightPx)
    }
    val haptic = rememberEnsuHaptics()
    val shape = RoundedCornerShape(EnsuCornerRadius.card.dp)
    val clickModifier = if (onClick != null) {
        Modifier.clickable {
            haptic.perform(HapticFeedbackType.TextHandleMove)
            onClick()
        }
    } else {
        Modifier
    }

    Box(
        modifier = modifier
            .size(width = width, height = height)
            .clip(shape)
            .background(EnsuColor.fillFaint(), shape)
            .border(1.dp, EnsuColor.border().copy(alpha = 0.7f), shape)
            .then(clickModifier),
        contentAlignment = Alignment.Center
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap!!,
                contentDescription = contentDescription,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop
            )
        } else {
            Icon(
                painter = painterResource(HugeIcons.Attachment01Icon),
                contentDescription = contentDescription,
                modifier = Modifier.size(24.dp),
                tint = EnsuColor.textMuted()
            )
        }

        if (isUploading) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    strokeWidth = 2.dp,
                    color = Color.White
                )
            }
        }

        if (onDelete != null) {
            IconButton(
                onClick = {
                    haptic.perform(HapticFeedbackType.LongPress)
                    onDelete()
                },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(4.dp)
                    .size(28.dp)
                    .background(Color.Black.copy(alpha = 0.42f), CircleShape)
            ) {
                Icon(
                    painter = painterResource(HugeIcons.Cancel01Icon),
                    contentDescription = "Remove image",
                    modifier = Modifier.size(12.dp),
                    tint = Color.White
                )
            }
        }
    }
}

private suspend fun decodeSampledImage(
    path: String?,
    targetWidthPx: Int,
    targetHeightPx: Int
): ImageBitmap? = withContext(Dispatchers.IO) {
    if (path.isNullOrBlank() || targetWidthPx <= 0 || targetHeightPx <= 0) {
        return@withContext null
    }

    val bounds = BitmapFactory.Options().apply {
        inJustDecodeBounds = true
    }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        return@withContext null
    }

    val options = BitmapFactory.Options().apply {
        inSampleSize = calculateInSampleSize(
            width = bounds.outWidth,
            height = bounds.outHeight,
            targetWidth = targetWidthPx,
            targetHeight = targetHeightPx
        )
    }

    BitmapFactory.decodeFile(path, options)?.asImageBitmap()
}

private fun calculateInSampleSize(
    width: Int,
    height: Int,
    targetWidth: Int,
    targetHeight: Int
): Int {
    var inSampleSize = 1
    if (height > targetHeight || width > targetWidth) {
        val halfHeight = height / 2
        val halfWidth = width / 2
        while (halfHeight / inSampleSize >= targetHeight && halfWidth / inSampleSize >= targetWidth) {
            inSampleSize *= 2
        }
    }
    return inSampleSize
}
