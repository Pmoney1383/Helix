package app.helix.call

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle
import app.helix.HelixApplication

/** Android's call system asks this service for the Connection behind each Helix call; the manager owns them. */
class HelixConnectionService : ConnectionService() {
    private val manager: CallAudioManager
        get() = CallAudioManager.instance ?: (application as HelixApplication).store.callAudio

    override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection =
        manager.createOutgoing()

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection =
        manager.createIncoming(request?.extras)

    override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) =
        manager.connectionFailed()

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) =
        manager.connectionFailed()
}
