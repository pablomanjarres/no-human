# infra/

Everything that runs the system but isn't application source: VM provisioning,
systemd units, launchd plists, database/cost config, uptime monitoring, secret
layout.

One subdirectory per concern. Nothing here is built by turbo — these are
deployment inputs, not workspace packages.
