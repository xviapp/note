# Embedded v2rayNG for 页间

This is a source snapshot of [2dust/v2rayNG](https://github.com/2dust/v2rayNG) at
`a4dd3d08de80958701247b00a8a979131192d1b4` (2.3.10), adapted as an Android library.
Copyright remains with the original authors. The original GPL-3.0 license is
included in `LICENSE`. The snapshot's configuration UI, resources, profile
formats, subscriptions, DNS and routing configuration are retained.

Host adaptations:

- Host package identity is `app.xvi.note`; use Xray irrespective of that identity.
- Library manifest has internal configuration activities, proxy-only/test/subscription
  services and its own FileProvider. No launcher, exported import handlers, VPN,
  root, tile, boot or automation registration.
- Remove VPN/TUN, root/iptables, per-app selection/process routing, LAN sharing,
  boot/Tasker/tile/widget/shortcut/URL-handler and standalone update source and resources.
  No dormant system-routing implementation is bundled.
- Enablement lives only in the host settings. Configuration edits still reload the running
  core. The silent foreground notification opens the host, with no independent controls.
- Back from configuration returns to the notebook. Appearance follows the host's saved
  light/dark/starry/system theme; the host currently uses Simplified Chinese. No independent
  module language, theme or dynamic-color preferences.
- The host About page shows source/core versions and opens a read-only license view.
  The standalone About/translators/promotion/community/feedback pages and launcher artwork
  are removed. License/source notices remain bundled.
- `embedded/EmbeddedProxy.kt` owns persisted enablement and the daemon's listener
  port, and normalizes runtime inbounds to a loopback SOCKS/HTTP mixed listener.
  Custom DNS/routing/outbounds remain intact. Listener settings are host reserved.
- `LauncherManager` starts only the internal proxy service. Core initialization,
  setup, shutdown and UI-requested reload are service owned; reload keeps the
  listener port and uses the existing daemon.
- `MessageHelper` supplies the acknowledged listener port to the host. The daemon
  acknowledges ordered state queries. No UI singleton is used as native liveness proof.
- Core configuration is not logged. Service/UI broadcasts are private to the host UID.
- Legacy system/listener settings in imported backups have no runtime consumers. The
  `process` field remains in serialization for backup compatibility, but generated
  configurations do not use package/UID selectors. Custom JSON remains editable.

Native dependency: AndroidLibXrayLite `ea96a7f9c33d6e18021386db96bf95680e853c93`,
release `v26.9.30`, Xray `b26a91de4f3294e26a0ad0a970b81a386a41f789`.
AAR SHA-256: `cf71680b776b9ca583747ba652f816b047a655eab875d8951e6141636d88bbd6`.
The host packages the AAR; this library compiles against its extracted classes.

GeoIP/GeoSite: Loyalsoldier/v2ray-rules-dat release `202610052207`, pinned hashes in
`build.gradle.kts`; users may update their data through the retained configuration UI.
Their upstream source and license: https://github.com/Loyalsoldier/v2ray-rules-dat
(GPL-3.0). Native source and license: https://github.com/2dust/AndroidLibXrayLite
(LGPL-3.0); Xray-core: https://github.com/XTLS/Xray-core (MPL-2.0).

Generated AAR/JAR/dat files are ignored. Updating the snapshot requires reviewing
these host adaptations and rerunning native and device integration checks.
