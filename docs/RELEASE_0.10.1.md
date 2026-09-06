# UniHub 0.10.1

This documentation and licensing release makes UniHub's maintenance approach,
usage terms and upgrade procedure explicit. The application features introduced
in 0.10.0 remain the same.

## Maintenance and documentation

UniHub is AI-written code maintained using OpenAI models, primarily **GPT 6
Astra**, with AI-assisted security reviews, regression tests and release checks.
The README now describes the project directly and welcomes feedback. A security
document explains the review process and private vulnerability reporting.

Documentation has been reviewed against the implementation, including mail
import transactions, streamed attachment downloads, session/cache isolation,
contacts pagination, calendar notifications, offline reading, backups and
deployment settings.

## License

Starting with **0.10.1**, project-owned code and documentation use **PolyForm
Noncommercial 1.0.0**: noncommercial use is free, and commercial use is welcome
under a separate paid written agreement. Contact **smrus@rus.family** with your
use case for scope and pricing. See [Licensing](../LICENSING.md).

The project is source-available. Earlier releases retain the permissions they
were supplied with; this change is prospective. Third-party components retain
their own licenses. The image now includes the project license, third-party
notices and collected frontend dependency notices under `/app/licenses`.

## Upgrading from 0.9.x

**0.9.23.0 is the tested schema baseline for an in-place upgrade to 0.10.x.**
The migration regression starts with that release's actual schema and populated
synthetic records, runs production initialization twice, and checks preservation
of users, mail/calendar data, encrypted credentials, attachment metadata and
custom folder settings. It also verifies new sync progress and encrypted VAPID
identity across restart. File contents and external mail providers are outside
that schema test.

Earlier 0.9.x versions and customized databases are not all runtime-verified.
Rehearse those upgrades on an isolated copy. Keep a consistent pre-upgrade backup
of MySQL, uploads and configuration. Preserve deployment keys and volume
mappings. **An image-only downgrade is not a verified rollback procedure.**
The [upgrade guide](UPGRADING.md) includes the commands and recovery path.

Retain the **300-second maximum MySQL wait**, which ends when an authenticated
probe succeeds, and **360-second application health startup grace**. Older
Compose files with explicit values need those values updated. The first mail
sync revalidates old imports and can take longer. Device notifications and
offline reading require opt-in after the upgrade.

## Validation

Publication requires the API suite, including the populated MySQL 8 upgrade and
fresh-install checks, frontend tests, lint, TypeScript and production build,
followed by the built-container startup/authentication/file/conversion smoke
test. The container smoke also checks that licensing notices and metadata are
present. CI results are linked from the GitHub release.

Actual minimized/locked-screen PWA notification delivery still needs checking
on the intended device; browser and OS policies are not reproduced by CI.
