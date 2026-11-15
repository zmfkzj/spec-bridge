#!/usr/bin/env sh
# Benchmark FIXTURE standing in for an AI provider (no model is called). It deliberately returns a
# wrong link candidate so case 10 can check that candidates never become facts without approval.
cat >/dev/null
printf '%s' '{"proposals":[{"type":"VERIFIES","from":"alloy:formal/booking.als#assert:SingleHolder","to":"openspec:payment/payment-confirmation","rationale":"both talk about holding a seat (wrong: the assertion is about seat holders, the requirement about payment)"}],"usage":{"tokens":0}}'
