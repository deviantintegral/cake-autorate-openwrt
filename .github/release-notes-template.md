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

<!-- ONE-TIME NOTE (v0.2.1). Delete this section in the first commit after this
     release -- this template is shared by every future release. -->
### Upgrading from v0.1.0 or v0.2.0

`luci-app-cake-autorate` is renumbered in this release, from `1.0.0` down to the
repo tag: the old `1.0.0` was a leftover from the package skeleton, and this app
has no upstream version of its own to track, so the tag is the honest answer.
apk will not walk a version backwards, so remove the app before installing:

```sh
apk del luci-app-cake-autorate
```

Then run the install command above. `/etc/config/cake-autorate` belongs to the
`cake-autorate` package, which is not being removed, so your settings are
untouched.

Note also that both earlier releases published their `.apk` files under these
same two filenames despite differing in content, so an `apk add` of one of them
over the other was a no-op. Installing this release fixes that for good — from
here on, every release carries a distinct version string.

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
