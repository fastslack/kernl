# Spec for Kernl — Fedora/RHEL/CentOS RPM
#
# Build with `packaging/rpm/build-rpm.sh` from the repo root. The script
# stages dist/, dashboard/build, a Linux-x64-pruned node_modules tree,
# and a vendored bun runtime into a tarball that rpmbuild consumes.
#
# Layout once installed:
#   /opt/kernl/                 application files (read-only)
#     bin/bun                       vendored bun runtime
#     bin/mcp-server.js             bundled kernel
#     node_modules/                 pruned native deps
#     dashboard/                    static SPA
#     assets/                       extensions, agents, skills
#   /usr/bin/kernl              wrapper script (cwd → ~/.local/share/kernl)
#   /usr/lib/systemd/user/kernl.service   systemd user unit
#   /usr/share/applications/kernl.desktop launcher entry
#   /usr/share/icons/hicolor/256x256/apps/kernl.png
#
# Per-user state (created on first run):
#   ~/.local/share/kernl/data/  sqlite, embeddings cache, extension installs
#   ~/.config/kernl/.env        user overrides (port, encryption key, etc.)

%global         appname     kernl
%global         appdir      /opt/%{appname}
%global         _build_id_links none

# We ship pre-built binaries — no source debug info to extract.
%global         debug_package %{nil}

# The onnxruntime CUDA/TensorRT provider .so files declare a soname
# (libonnxruntime.so.1, libonnxruntime_providers_cuda.so, …) that rpmbuild
# would otherwise lift into a hard Requires:. We don't want that — the
# CUDA providers are dead weight on a CPU-only install and TensorRT pulls
# in nvidia drivers nobody asked for. Strip them from the auto-find set.
%global         __requires_exclude (libonnxruntime|libonnxruntime_providers_cuda|libonnxruntime_providers_tensorrt|libonnxruntime_providers_shared|libcuda|libcublas|libcudart|libcudnn|libcufft|libcurand|libnvinfer|libnvinfer_plugin|libnvonnxparser|libnvrtc)
%global         __provides_exclude (libonnxruntime|libonnxruntime_providers)

# Everything under the app directory is a vendored, self-contained tree: a bun
# binary plus prebuilt native node modules. Letting rpm scan it for deps is
# not just noise, it produces an uninstallable package — the prebuilt objects
# link against the unversioned `libdl.so` and `libm.so` development sonames,
# which no modern distro provides (glibc 2.34 merged both into libc). The
# result installs nowhere:
#
#     nothing provides libdl.so()(64bit) needed by kernl-0.1.0-1.x86_64
#
# The real runtime dependencies are declared explicitly as Requires: below,
# so exclude the bundle from automatic generation entirely rather than chase
# sonames one at a time.
%global         __requires_exclude_from ^%{appdir}/.*$
%global         __provides_exclude_from ^%{appdir}/.*$

# The release builder runs on ubuntu-latest, whose rpm does not define
# %%_userunitdir — it is a Fedora/RHEL macro. Left undefined it is not expanded
# at all, so the unit lands in a directory named after the literal macro text
# and systemd never sees it. Define it only when the builder hasn't.
%{!?_userunitdir: %global _userunitdir /usr/lib/systemd/user}

# node_modules ships prebuilt binaries for foreign architectures
# (bare-os/prebuilds/android-arm, android-arm64, linux-arm64, ...). brp-strip
# cannot parse them, and its failure aborts %install outright. Nothing here is
# worth stripping anyway: the payload is a JS tree plus a vendored bun binary,
# not compiled objects we own.
%global         __os_install_post %{nil}

Name:           %{appname}
Version:        0.1.1
Release:        1%{?dist}
Summary:        Personal life-management MCP server with dashboard
License:        Apache-2.0
URL:            https://github.com/fastslack/kernl
Source0:        %{name}-%{version}.tar.gz
BuildArch:      x86_64

# Runtime deps — kernel won't start without these. libstdc++ is for
# onnxruntime. There is deliberately no sqlite dependency: better-sqlite3
# compiles SQLite into better_sqlite3.node, so `ldd` on it shows only libc,
# libgcc_s, libm, libpthread and libstdc++ — no libsqlite3 at all.
#
# Requiring it was worse than redundant. On RHEL and its rebuilds the package
# named `sqlite` is the CLI, is not installed by default, and nothing pulls it
# in, so `rpm -i` refused outright:
#
#     error: Failed dependencies: sqlite is needed by kernl-0.1.1-1.x86_64
#
# That took out Rocky, Alma and CentOS Stream while Fedora installed fine.
# Verified with --nodeps on rockylinux:9: the kernel starts, opens its
# database and serves the dashboard.
Requires:       glibc >= 2.34
Requires:       libstdc++

# Optional but strongly recommended — features degrade gracefully when
# missing. ffmpeg powers cinema/torrents transcoding; bubblewrap backs
# the CubeSandbox driver; docker-ce is an alternative sandbox driver.
Recommends:     ffmpeg
Recommends:     bubblewrap
Suggests:       docker-ce
# neo4j-server is intentionally not listed — Tier 2 users install it
# manually (Neo4j Desktop or container) and wire it up via the dashboard's
# /extensions panel against an existing Bolt endpoint.

# We don't compile anything in the RPM build — the tarball ships pre-built
# JS and pre-resolved native modules. So no BuildRequires.

%description
Kernl is an MCP (Model Context Protocol) server that exposes your
tasks, contacts, reminders, calendar, finances, notes, and more as a
single coherent agentic surface. Ships with a Svelte dashboard at
http://localhost:3086 and works out of the box without external
dependencies. Optional extensions enable graph analytics (Neo4j),
sandboxed agent execution, and federated sync.

This package is self-contained — it bundles the Bun runtime and pruned
native modules for Linux x86_64. No internet access is required after
install except for online LLM features (which are also opt-in).

%prep
%setup -q -n %{name}-%{version}

%build
# No build step — tarball is pre-built. Verify the layout we expect.
test -x bin/bun || (echo "bin/bun missing in source tarball" && exit 1)
test -f bin/mcp-server.js || (echo "bin/mcp-server.js missing" && exit 1)
test -d node_modules/better-sqlite3 || (echo "better-sqlite3 missing" && exit 1)

%install
rm -rf %{buildroot}

# Application tree
install -d %{buildroot}%{appdir}
cp -a bin %{buildroot}%{appdir}/
cp -a node_modules %{buildroot}%{appdir}/
cp -a dashboard %{buildroot}%{appdir}/
cp -a assets %{buildroot}%{appdir}/
install -m 0644 package.json %{buildroot}%{appdir}/

# Wrapper script (cd to per-user data dir, exec vendored bun)
install -d %{buildroot}%{_bindir}
install -m 0755 packaging/kernl.sh %{buildroot}%{_bindir}/%{appname}

# systemd user unit
install -d %{buildroot}%{_userunitdir}
install -m 0644 packaging/kernl.service %{buildroot}%{_userunitdir}/%{appname}.service

# Desktop entry + icon
install -d %{buildroot}%{_datadir}/applications
install -m 0644 packaging/kernl.desktop %{buildroot}%{_datadir}/applications/%{appname}.desktop
install -d %{buildroot}%{_datadir}/icons/hicolor/256x256/apps
install -m 0644 packaging/kernl.png %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/%{appname}.png

# Default config template (user copies to ~/.config/kernl/.env)
install -d %{buildroot}%{_sysconfdir}/%{appname}
install -m 0644 packaging/env.example %{buildroot}%{_sysconfdir}/%{appname}/env.example

%files
%{appdir}
%{_bindir}/%{appname}
%{_userunitdir}/%{appname}.service
%{_datadir}/applications/%{appname}.desktop
%{_datadir}/icons/hicolor/256x256/apps/%{appname}.png
%dir %{_sysconfdir}/%{appname}
%config %{_sysconfdir}/%{appname}/env.example

%post
# Refresh icon and desktop caches so the launcher appears immediately.
gtk-update-icon-cache -t %{_datadir}/icons/hicolor &>/dev/null || :
update-desktop-database &>/dev/null || :

cat <<EOF

Kernl installed.

  Start:        systemctl --user enable --now kernl
                (or just run \`kernl\` from a terminal)
  Open:         xdg-open http://localhost:3086
  Configure:    cp /etc/kernl/env.example ~/.config/kernl/.env
                then edit (port, encryption key, LLM API keys, etc.)

Optional Tier 2 (graph analytics + ML trading):
  - Install Neo4j Desktop or run a Neo4j container
  - Open http://localhost:3086/extensions, filter "Database",
    activate "Neo4j" and provide your bolt://… endpoint.

EOF

%postun
gtk-update-icon-cache -t %{_datadir}/icons/hicolor &>/dev/null || :
update-desktop-database &>/dev/null || :

%changelog
* Mon May 04 2026 Matias Aguirre <fastslack@gmail.com> - 0.1.0-1
- Initial RPM packaging.
- Self-contained tarball (Bun runtime + pruned linux-x64 native modules).
- systemd user unit; per-user state at ~/.local/share/kernl.
- Tier 1 (no graph DB) works out of the box; graph backends opt-in via
  /extensions panel.
