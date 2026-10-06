package com.v2ray.ang.enums

import android.Manifest
import androidx.annotation.StringRes
import com.v2ray.ang.R

/** Only QR import needs an interactive permission request. */
enum class PermissionType {
    CAMERA;
    fun getPermission(): String = Manifest.permission.CAMERA
    @StringRes fun getLabelRes(): Int = R.string.permission_camera
}
