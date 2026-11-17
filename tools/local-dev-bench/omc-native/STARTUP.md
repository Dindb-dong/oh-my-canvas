# Native service saved-library startup

```sh
node --test tools/local-dev-bench/omc-native/startup.test.mjs
node tools/local-dev-bench/omc-native/startup.mjs --saved-docs 0
node tools/local-dev-bench/omc-native/startup.mjs \
  --saved-docs 15 --saved-nodes 1000 --target-nodes 100
```

N-F records service readiness, first catalog listing, thumbnail generation,
first verified target snapshot and first durable edit under a new service
process on an isolated profile. The probe saves, closes and verifies warm
reopen afterward. Use `--fixture-only` to validate the plan before launching. The
saved count excludes the target. The first process-cold measurement starts
without an open target. The second starts after preparing the one target,
then verifies that target by stable document identity and expected object count.
Native catalog responses can include thumbnails for at most 15 documents.

Preparation is tracked separately, and process restart preserves the
catalog. OS cache is uncontrolled. Screen presentation, physical disk reads,
and asset/font readiness need additional observation.
The service-only route is an internal startup diagnostic.
