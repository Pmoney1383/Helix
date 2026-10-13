package app.helix

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.helix.model.FrontDoor
import app.helix.service.GatewayService
import app.helix.service.Notifier
import app.helix.ui.RootScreen
import java.lang.ref.WeakReference

class MainActivity : FragmentActivity() {
    private val store get() = (application as HelixApplication).store

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        store.activity = WeakReference(this)
        setContent { RootScreen(store) }
        handle(intent)
        if (store.isPaired) GatewayService.start(this)
        askForPermissions()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        store.activity = WeakReference(this)
    }

    /** A tapped notification, the ring's Answer, or a "Call Claude" shortcut. */
    private fun handle(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(Notifier.EXTRA_OPEN)?.let { store.open(it); intent.removeExtra(Notifier.EXTRA_OPEN) }
        intent.getStringExtra(EXTRA_CALL)?.let { name ->
            FrontDoor.entries.firstOrNull { it.name == name }?.let(store::startCall)
            intent.removeExtra(EXTRA_CALL)
        }
    }

    /** Notifications (alerts and calls) and the microphone (calls), asked once up front - as the iPhone asks before a call. */
    private fun askForPermissions() {
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            add(Manifest.permission.RECORD_AUDIO)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isNotEmpty()) askPermissions.launch(wanted.toTypedArray())
    }

    companion object {
        const val EXTRA_CALL = "helix.call"
    }
}
