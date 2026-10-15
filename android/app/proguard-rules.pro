# Preserve useful source locations in crash reports; keep the matching
# app/build/outputs/mapping/release/mapping.txt with every release artifact.
-keepattributes SourceFile,LineNumberTable

# Capacitor plugin callbacks
# are protected by dependency consumer rules. Android's optimize defaults
# protect @JavascriptInterface methods used by the WebView bridge.
