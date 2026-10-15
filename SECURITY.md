# Security policy

## Model

cpu3d is a local tool. The server:

- binds to `127.0.0.1` by default,
- rejects requests whose `Host` or `Origin` header is not localhost (protection against DNS rebinding),
- serves only whitelisted folders of the project,
- never evaluates code from recipes or agent input; recipes are validated JSON with limits on segment counts, points and triangles per object.

Do not expose the server to a network you do not trust: anyone who can reach it can edit the scene.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab) instead of a public issue. You will get an answer within a few days.
