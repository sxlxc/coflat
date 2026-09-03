# Vendored `pandocmd-cst` snapshot

This directory is a development-only package input for standalone Coflat
checkouts. Its source is copied without modification from the sibling
`pandocmd-cst` v1 workspace used for the M6 migration.

The sibling `pandocmd-cst` repository remains authoritative. Do not implement
CST behavior here. Refresh this snapshot from a tested CST commit, update the
package version, and then regenerate `pnpm-lock.yaml`.

Vite bundles this package into Coflat's editor output. It is not exposed as a
runtime dependency of the published Coflat package.
