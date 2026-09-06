#!/bin/sh
# Wrapper satisfying the process factory's single-binary spawn contract
# (BRIDGE_CLAUDE_BIN): exec node with the fake-claude fixture, forwarding
# the driver args verbatim. Fake-claude runtime behavior (e.g. withholding
# result records when FAKE_CLAUDE_NO_RESULT=1) is controlled by the child
# environment, not by extra argv.
exec node "$(dirname "$0")/fake-claude.mjs" "$@"
