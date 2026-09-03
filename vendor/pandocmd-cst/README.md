# Vendored `pandocmd-cst` snapshot

This directory is a development-only package input for standalone Coflat
checkouts while `pandocmd-cst` is unpublished. Its source is copied without
modification from `pandocmd-cst` commit
`d2a5c8853cf3a252e124403227256502baa65cf9`.

The sibling `pandocmd-cst` repository remains authoritative. Do not implement
CST behavior here. Refresh this snapshot from a tested CST commit, update the
commit above and the package version, and then regenerate `pnpm-lock.yaml`.

Vite bundles this package into Coflat's editor output. It is not exposed as a
runtime dependency of the published Coflat package.
