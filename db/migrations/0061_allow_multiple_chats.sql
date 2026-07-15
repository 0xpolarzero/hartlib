-- The historical compatibility sequence installed chats_user_key while
-- duplicate-user chats were repaired. The canonical platform permits multiple
-- chats per user, so converge any ledgered database that still has the
-- obsolete index. Earlier canonical migrations may already have removed it;
-- this terminal guard remains safe and records the forward convergence.

drop index if exists chats_user_key;
