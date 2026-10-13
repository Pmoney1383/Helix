package app.helix.call

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/**
 * Mic capture with Android's speech recognizer, the phone's own voice (TextToSpeech), the PC voice's raw audio and
 * barge-in, all on the voice-call audio path (the iPhone's VoiceLoop.swift). A call speaks several sentences in a row as
 * they stream in (`agent.speech`), so [speak] queues rather than replacing.
 *
 * Everything here runs on the main thread except the PCM writer thread.
 */
class VoiceLoop(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())

    var onFinalUtterance: ((String) -> Unit)? = null
    /** True while speaking or with more queued: drives the call's "Speaking"/"Listening" without flicker. */
    var onBusyChanged: ((Boolean) -> Unit)? = null
    var isBusy = false
        private set
    /** Names the recognizer would otherwise mishear (project names, "Astra", "Claude"); Android 13+ uses them as hints. */
    var contextualStrings: List<String> = emptyList()

    /** While muted the recognizer is stopped, so nothing the user says is sent. */
    var isMuted = false
        set(value) {
            field = value
            if (value) stopRecognizer() else if (running) startRecognizer()
        }

    private var running = false
    private var recognizer: SpeechRecognizer? = null
    private var recognizerActive = false
    private var restartPending: Runnable? = null
    private var lastPartial = ""

    // MARK: Lifecycle

    /** `onReady` fires once listening has started (the iPhone waits for the audio route to settle the same way). */
    fun start(onReady: (() -> Unit)? = null) {
        if (running) return
        running = true
        ensureTts()
        startRecognizer()
        main.postDelayed({ if (running) onReady?.invoke() }, 350)
    }

    fun stop() {
        running = false
        stopRecognizer()
        stopSpeakingAndClearQueue()
        pcm.stop()
    }

    fun release() {
        stop()
        tts?.shutdown()
        tts = null
        recognizer?.destroy()
        recognizer = null
    }

    // MARK: Speech recognition

    private fun startRecognizer() {
        if (!running || isMuted || recognizerActive) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            Log.w(TAG, "speech recognition is not available on this phone")
            return
        }
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        r.setRecognitionListener(listener)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1000L)
            if (Build.VERSION.SDK_INT >= 33 && contextualStrings.isNotEmpty()) {
                putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(contextualStrings.take(100)))
            }
        }
        lastPartial = ""
        recognizerActive = true
        runCatching { r.startListening(intent) }.onFailure {
            recognizerActive = false
            scheduleRestart(600)
        }
    }

    private fun stopRecognizer() {
        restartPending?.let(main::removeCallbacks)
        restartPending = null
        recognizerActive = false
        runCatching { recognizer?.cancel() }
    }

    private fun scheduleRestart(delayMs: Long) {
        restartPending?.let(main::removeCallbacks)
        val task = Runnable { restartPending = null; startRecognizer() }
        restartPending = task
        main.postDelayed(task, delayMs)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
            if (text.isBlank()) return
            lastPartial = text
            // Barge-in. Without the iPhone's echo canceller in the loop, the phone can hear its own voice: two or more
            // words are required, so a stray syllable of our own speech does not cut the reply off.
            if (speaking && text.trim().split(Regex("\\s+")).size >= 2) stopSpeakingAndClearQueue()
        }

        override fun onResults(results: Bundle?) {
            recognizerActive = false
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty().ifEmpty { lastPartial.trim() }
            lastPartial = ""
            if (text.isNotEmpty() && !speaking) onFinalUtterance?.invoke(text)
            scheduleRestart(0)
        }

        override fun onError(error: Int) {
            recognizerActive = false
            // No match and silence are normal ends; anything else backs off a little so a failing recognizer cannot spin.
            val normal = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            scheduleRestart(if (normal) 0 else 600)
        }
    }

    // MARK: The phone's voice (TextToSpeech), queued

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val speechQueue = ArrayDeque<String>()
    private var speaking = false
    private var currentUtterance: String? = null

    private fun ensureTts() {
        if (tts != null) return
        tts = TextToSpeech(context) { status ->
            main.post {
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    tts?.language = Locale.US
                    tts?.setAudioAttributes(callAttributes)
                    processQueue()
                }
            }
        }.apply {
            setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) = main.post { finished(utteranceId) }.let { }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = main.post { finished(utteranceId) }.let { }
                override fun onStop(utteranceId: String?, interrupted: Boolean) = main.post { finished(utteranceId) }.let { }
            })
        }
    }

    fun speak(text: String) {
        speechQueue.addLast(text)
        ensureTts()
        processQueue()
        updateBusy()
    }

    private fun processQueue() {
        if (speaking || !ttsReady || speechQueue.isEmpty()) return
        val text = speechQueue.removeFirst()
        val id = UUID.randomUUID().toString()
        currentUtterance = id
        speaking = true
        tts?.speak(text, TextToSpeech.QUEUE_ADD, null, id)
        updateBusy()
    }

    private fun finished(id: String?) {
        if (id == null || id != currentUtterance) return
        currentUtterance = null
        speaking = false
        processQueue()
        updateBusy()
    }

    /** Barge-in, end of call, and an interrupt from the server all land here. */
    fun stopSpeakingAndClearQueue() {
        speechQueue.clear()
        currentUtterance = null
        speaking = false
        tts?.stop()
        pcm.cancel()
        pcAwaitingEnd = false
        updateBusy()
    }

    // MARK: PC voice (raw audio generated on the PC)

    private var pcAwaitingEnd = false
    private val pcm = PcmPlayer { main.post { updateBusy() } }

    /** True from the first sentence the PC voice will speak until `agent.audio.end`: a gap is not the end of the turn. */
    fun setPCTurnActive(active: Boolean) {
        pcAwaitingEnd = active
        if (!active) pcm.flush()
        updateBusy()
    }

    /** One piece of a sentence: mono signed 16-bit little-endian PCM. */
    fun playPCM(data: ByteArray, sampleRate: Int) {
        if (data.size < 2 || sampleRate <= 0) return
        pcm.enqueue(data, sampleRate)
        updateBusy()
    }

    /** A whole recorded clip (wav): the greeting, or what Helix says when it calls you. */
    fun playClip(wav: ByteArray) {
        val parsed = Wav.parse(wav) ?: run { Log.e(TAG, "could not decode a clip (${wav.size} bytes)"); return }
        pcm.enqueue(parsed.first, parsed.second)
        pcm.flush()
        updateBusy()
    }

    /** The ringback tone, through the same player so it takes the call's route. `completion` runs when it has played. */
    fun playTone(samples: ShortArray, sampleRate: Int, completion: () -> Unit) {
        val bytes = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN).apply { asShortBuffer().put(samples) }.array()
        pcm.enqueue(bytes, sampleRate)
        pcm.flush()
        pcm.whenDrained { main.post(completion) }
    }

    private fun updateBusy() {
        val busy = speaking || speechQueue.isNotEmpty() || pcm.isPlaying || pcAwaitingEnd
        if (busy == isBusy) return
        isBusy = busy
        onBusyChanged?.invoke(busy)
    }

    private companion object {
        const val TAG = "VoiceLoop"
        val callAttributes: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
    }

    /**
     * Streams 16-bit mono PCM through one AudioTrack on the voice-call path. A small jitter buffer (0.4 s, or 0.3 s for a
     * short first piece) is collected before playback starts, then every piece is written as it arrives, gapless.
     */
    private class PcmPlayer(private val onStateChanged: () -> Unit) {
        private val queue = LinkedBlockingQueue<Pair<ByteArray, Int>>()
        private val handler = Handler(Looper.getMainLooper())
        private var pending = mutableListOf<Pair<ByteArray, Int>>()
        private var pendingSeconds = 0.0
        private var flushTimer: Runnable? = null
        private var drainedCallbacks = mutableListOf<() -> Unit>()
        @Volatile private var writing = 0
        @Volatile private var generation = 0
        private var track: AudioTrack? = null
        private var trackRate = 0

        val isPlaying: Boolean get() = writing > 0 || pending.isNotEmpty() || queue.isNotEmpty()

        private val writer = thread(name = "helix-pcm", isDaemon = true) {
            while (true) {
                val (data, rate) = queue.take()
                val gen = generation
                val t = trackFor(rate)
                var offset = 0
                while (offset < data.size && gen == generation) {
                    val n = t.write(data, offset, data.size - offset)
                    if (n <= 0) break
                    offset += n
                }
                if (queue.isEmpty()) {
                    // Let the tail play out before calling it done.
                    Thread.sleep(((t.bufferSizeInFrames.toDouble() / rate) * 1000).toLong().coerceIn(50, 400))
                }
                synchronized(this) { writing = (writing - 1).coerceAtLeast(0) }
                if (writing == 0 && queue.isEmpty()) handler.post {
                    onStateChanged()
                    if (!isPlaying) { val callbacks = drainedCallbacks; drainedCallbacks = mutableListOf(); callbacks.forEach { it() } }
                }
            }
        }

        fun enqueue(data: ByteArray, rate: Int) {
            if (writing > 0 && pending.isEmpty()) { submit(data, rate); return } // already playing: keep it gapless
            pending += data to rate
            pendingSeconds += data.size / 2.0 / rate
            if (pendingSeconds >= 0.4) flush()
            else if (pending.size == 1) {
                flushTimer?.let(handler::removeCallbacks)
                val task = Runnable { flush() }
                flushTimer = task
                handler.postDelayed(task, 300)
            }
        }

        fun flush() {
            flushTimer?.let(handler::removeCallbacks)
            flushTimer = null
            val items = pending
            pending = mutableListOf()
            pendingSeconds = 0.0
            items.forEach { submit(it.first, it.second) }
        }

        fun whenDrained(callback: () -> Unit) {
            if (!isPlaying) callback() else drainedCallbacks += callback
        }

        private fun submit(data: ByteArray, rate: Int) {
            synchronized(this) { writing++ }
            queue.put(data to rate)
        }

        fun cancel() {
            generation++
            queue.clear()
            pending.clear()
            pendingSeconds = 0.0
            synchronized(this) { writing = 0 }
            drainedCallbacks.clear()
            runCatching { track?.pause(); track?.flush(); track?.play() }
        }

        fun stop() {
            cancel()
            runCatching { track?.stop(); track?.release() }
            track = null
            trackRate = 0
        }

        private fun trackFor(rate: Int): AudioTrack {
            track?.let { if (trackRate == rate) return it }
            runCatching { track?.stop(); track?.release() }
            val minBuffer = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val t = AudioTrack.Builder()
                .setAudioAttributes(callAttributes)
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(minBuffer, rate / 5 * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            t.play()
            track = t
            trackRate = rate
            return t
        }
    }
}

/** Minimal WAV reader for the gateway's clips: 16-bit PCM, mono or stereo (stereo is folded to mono). */
object Wav {
    fun parse(bytes: ByteArray): Pair<ByteArray, Int>? {
        if (bytes.size < 44 || String(bytes, 0, 4) != "RIFF" || String(bytes, 8, 4) != "WAVE") return null
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var offset = 12
        var channels = 1
        var rate = 0
        var bits = 16
        while (offset + 8 <= bytes.size) {
            val id = String(bytes, offset, 4)
            val size = buffer.getInt(offset + 4)
            val body = offset + 8
            if (id == "fmt ") {
                channels = buffer.getShort(body + 2).toInt()
                rate = buffer.getInt(body + 4)
                bits = buffer.getShort(body + 14).toInt()
            } else if (id == "data") {
                if (bits != 16 || rate <= 0) return null
                val end = minOf(bytes.size, body + size)
                val data = bytes.copyOfRange(body, end)
                if (channels == 1) return data to rate
                val frames = data.size / (2 * channels)
                val mono = ByteBuffer.allocate(frames * 2).order(ByteOrder.LITTLE_ENDIAN)
                val src = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
                for (f in 0 until frames) {
                    var sum = 0
                    for (c in 0 until channels) sum += src.getShort((f * channels + c) * 2)
                    mono.putShort((sum / channels).toShort())
                }
                return mono.array() to rate
            }
            offset = body + size + (size and 1)
        }
        return null
    }
}
