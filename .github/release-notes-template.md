Prebuilt **noarch** packages for **OpenWrt 25.12.5**, built from this tag by
`.github/workflows/release.yml` using the same recipe CI tests every commit
with.

### Install

Download both `.apk` files, copy them to the router, and install them together
so the dependency between them resolves in one shot:

```sh
apk add --allow-untrusted ./__CA_APK__ ./__LUCI_APK__
```

`--allow-untrusted` is required because these assets are not signed by an apk
repository key. Verify them against `SHA256SUMS` below before installing.

`apk` pulls the runtime dependencies (`bash`, `fping`, `tc`,
`kmod-sched-cake`, `sqm-scripts`, `collectd-mod-exec`) from the official
OpenWrt repositories. `tc` is virtual, so an existing `tc-tiny` *or* `tc-full`
satisfies it.

Then configure at least one instance's interfaces and rates (LuCI →
**Network → CAKE Autorate**, or `/etc/config/cake-autorate`), set
`option enabled '1'`, and start it:

```sh
/etc/init.d/cake-autorate enable
/etc/init.d/cake-autorate start
```

See the [README](__REPO_URL__/blob/main/README.md) and the
[configuration guide](__REPO_URL__/blob/main/docs/configuration.md).

### Checksums

```
__SHASUMS__
```
