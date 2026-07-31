# Security policy

Please report suspected LinkDish security vulnerabilities privately by email
to [support@linkdish.ca](mailto:support@linkdish.ca).

Include:

- the affected component or URL;
- a clear description of the impact;
- reproducible steps or a proof of concept;
- any suggested mitigation;
- a safe way to contact you.

Do not include credentials, personal information, or unnecessary production
data. Do not open a public issue for an unpatched vulnerability.

This project does not currently operate a bug-bounty program. Submission of a
report does not create a promise of payment or a response deadline.

## Dependency audit exception

`GHSA-qwww-vcr4-c8h2` applies only to React Router's unstable React Server
Components APIs. LinkDish uses React Router's browser-only declarative mode and
does not import or enable those APIs. The pnpm production audit ignores that
specific advisory while the project remains on the React Router 7 application
baseline; no other production advisory is ignored.
