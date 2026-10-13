package app.helix

import android.app.Application
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.helix.model.FrontDoor
import app.helix.service.Notifier
import app.helix.store.HelixStore
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

class HelixApplication : Application() {
    lateinit var notifier: Notifier
        private set
    lateinit var store: HelixStore
        private set

    override fun onCreate() {
        super.onCreate()
        notifier = Notifier(this).also { it.createChannels() }
        store = HelixStore(this, notifier)
        publishShortcuts()

        // Coming to the foreground: check the gateway again and wake the PC voice (the iPhone does this on scene active).
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                MainScope().launch { store.refreshGatewayStatus() }
                store.warmVoice()
            }
        })
    }

    /** "Call Claude" and "Call Astra" when the launcher icon is long-pressed (the iPhone offers these through Siri). */
    private fun publishShortcuts() {
        val manager = getSystemService(ShortcutManager::class.java) ?: return
        runCatching {
            manager.dynamicShortcuts = FrontDoor.entries.map { door ->
                ShortcutInfo.Builder(this, "call-${door.name.lowercase()}")
                    .setShortLabel("Call ${door.displayName}")
                    .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
                    .setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_CALL, door.name))
                    .build()
            }
        }
    }
}
