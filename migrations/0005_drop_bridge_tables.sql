-- phase: contract
-- after: 0001
--
-- The Live chat bridge is retired (T3 J3a): Live #20/#21 route every producer through Chat's own
-- ingress (`/internal/chat/*`, docs/chat-ingress.md), Chat no longer mounts the bridge routes, and
-- nothing reads or writes bridge_applied (the bridge's idempotency ledger for Live's outbox
-- deliveries) or bridge_refs (its map from a Live boot's placeholder ids to the real chat_messages
-- ids) any more. docs/cutover.md recorded the cutover with them kept as data until this migration
-- (J3b). deploy_releases.bridge_at / first_via stay as data: they record how a release was applied.
DROP TABLE IF EXISTS bridge_applied;
DROP TABLE IF EXISTS bridge_refs;
