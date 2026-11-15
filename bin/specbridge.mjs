#!/usr/bin/env node
// SpecBridge CLI entry. Requires Node >= 22.18 (native TypeScript type stripping).
import { main } from '../src/cli.ts'

main(process.argv.slice(2)).then(code => { process.exitCode = code }, err => {
  console.error(`specbridge: ${err?.stack ?? err}`)
  process.exitCode = 2
})
