package app.helix.auth

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Fingerprint or face, falling back to the screen lock (PIN, pattern, password) - the iPhone's Face ID / passcode check
 * before approving anything. Rejecting never asks.
 */
object DeviceAuth {
    private const val ALLOWED = BIOMETRIC_STRONG or DEVICE_CREDENTIAL

    suspend fun confirm(activity: FragmentActivity, reason: String): Boolean {
        // No screen lock at all: nothing to ask for, and refusing would make Approve unusable (as on the iPhone).
        if (BiometricManager.from(activity).canAuthenticate(ALLOWED) != BiometricManager.BIOMETRIC_SUCCESS) return true
        return suspendCancellableCoroutine { cont ->
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { if (cont.isActive) cont.resume(true) }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { if (cont.isActive) cont.resume(false) }
            })
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle(reason)
                    .setAllowedAuthenticators(ALLOWED)
                    .build(),
            )
        }
    }
}
