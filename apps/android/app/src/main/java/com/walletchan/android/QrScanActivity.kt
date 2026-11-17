package com.walletchan.android

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * ZXing's capture screen, declared in our manifest so it is locked to portrait.
 * It runs in its own activity on top of MainActivity, which stays alive (no
 * recreation; the result comes back through the Activity Result API).
 */
class QrScanActivity : CaptureActivity()
