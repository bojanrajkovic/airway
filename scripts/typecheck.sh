#!/bin/sh
# Type-checks the root project, then each package's src project and, when it has one, its tests
# project. Every project runs even after one fails, so a single run shows all the errors.
status=0
tsc --project . || status=1
for package in packages/*/; do
  # A directory without package.json is a leftover from another branch, not a package.
  [ -e "${package}package.json" ] || continue
  tsc --project "$package" || status=1
  if [ -e "${package}tests/tsconfig.json" ]; then
    tsc --project "${package}tests" || status=1
  fi
done
exit $status
