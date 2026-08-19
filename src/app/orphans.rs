//! Finding companies that lost their tenant, and owner rows that lost their
//! company (issue #1077).
//!
//! # What this is for
//!
//! In shared-single-DB mode the durable `owners` collection is what maps a
//! company to the tenant that may address it. Boot rebuilds the in-memory map
//! from those rows (`src/bin/opencompany.rs`), and `authorize_address` refuses
//! any tenant-scoped request whose company has no row. A company row that
//! outlived its owner row is therefore **invisible to its own tenant**: every
//! request for it answers `403`, and nothing in the product says why.
//!
//! Issue #1050 closed the source of new ones — provisioning now writes the
//! owner row before building the runtime and fails the request outright if that
//! write does not land. This module is about the rows the old behaviour already
//! left behind, which that fix does nothing for: there was no way to find them.
//!
//! # Report-only, deliberately
//!
//! Nothing here repairs anything, and that is a decision rather than an
//! omission. Adopting an orphan means guessing its tenant, and the only
//! available signal is the shape of the id (`tenant-a--acme`) — a heuristic,
//! and absent entirely for an explicitly-set id. A wrong guess hands one
//! tenant's company to another, which is a strictly worse failure than the one
//! being repaired. An operator reading this report can already address the
//! company with a platform-scoped credential (`authorize_address` allows
//! platform scope before it ever consults the owner map) and put it right
//! deliberately.
//!
//! # Why no new port method
//!
//! Both halves already exist as reads on backends that have them:
//! `CompanyStore::list` and `OwnershipStore::owners`. This is a set difference
//! over the two, so a new trait method would mean implementing it in every
//! backend for a query either side already answers.
//!
//! # One known false positive, in the benign direction
//!
//! `list()` is the presence oracle, and the Mongo implementation **skips any
//! company whose stored manifest does not parse** (`src/store/mongodb.rs`,
//! `let Ok(manifest) = toml::from_str(...) else { continue }`). Such a company
//! is absent from `list()` while its `owners` row is intact, so it is reported
//! as a [`DanglingOwner`] rather than as what it is: a company with a corrupt
//! manifest.
//!
//! Left as-is deliberately. The misreport lands in the direction this module
//! already calls benign, it names the right company id either way, and the
//! alternative — a second read that distinguishes "absent" from "unparseable"
//! — is the port method the section above argues against. An operator who
//! cannot find the named company in `list()` but does find the document has
//! learned something true and useful. Worth knowing before anyone builds an
//! automatic reconciler on top of this: deleting a "dangling" row would throw
//! away the ownership of a company that still exists.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::ports::types::{CompanyId, CompanySummary};

/// A company with no `owners` row: present in the store, addressable by nobody.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UnownedCompany {
    /// The company id, as the company store holds it.
    pub id: CompanyId,
    /// Its display name, so an operator can recognise it without a second
    /// lookup.
    pub name: String,
    /// Its lifecycle state. A company already retired is a much less urgent
    /// finding than a live one nobody can reach.
    pub lifecycle: String,
}

/// An `owners` row naming a company the store does not have.
///
/// Benign, unlike [`UnownedCompany`] — it hides no data and blocks no request.
/// Worth reporting because #1050's fix deliberately makes this the *safe*
/// failure direction: provisioning writes the owner row first and rolls it back
/// only on a best-effort basis, so a leftover row is expected by design rather
/// than hypothetical, and an operator reconciling the two collections wants
/// both halves in one answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DanglingOwner {
    /// The company id the row names.
    pub id: CompanyId,
    /// The tenant the row assigns it to, as persisted (not canonicalised).
    pub tenant: String,
}

/// Both directions of the company ↔ owner mismatch.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct OrphanReport {
    /// Companies present in the store with no owner row. These are the finding
    /// that matters: their tenant gets a `403` and no explanation.
    pub unowned: Vec<UnownedCompany>,
    /// Owner rows naming a company that is not in the store. Benign.
    pub dangling: Vec<DanglingOwner>,
}

impl OrphanReport {
    /// True when neither direction found anything — the expected state.
    ///
    /// Exists so a caller can stay silent rather than printing an empty report:
    /// a boot line saying "0 orphans" on every restart of every healthy
    /// deployment trains operators to skip the one that says otherwise.
    pub fn is_empty(&self) -> bool {
        self.unowned.is_empty() && self.dangling.is_empty()
    }

    /// Both halves of the report, one finding per line.
    ///
    /// A human-readable block. Empty string when there is nothing to say, so a
    /// caller can print it unconditionally.
    pub fn to_text(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        if !self.unowned.is_empty() {
            let _ = writeln!(
                out,
                "Companies with no owner row ({}) — unreachable by their tenant:",
                self.unowned.len()
            );
            for company in &self.unowned {
                let _ = writeln!(
                    out,
                    "  {}  {}  [{}]",
                    company.id.as_ref(),
                    company.name,
                    company.lifecycle
                );
            }
        }
        if !self.dangling.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            let _ = writeln!(
                out,
                "Owner rows naming no company ({}) — harmless, but worth clearing:",
                self.dangling.len()
            );
            for row in &self.dangling {
                let _ = writeln!(out, "  {}  -> {}", row.id.as_ref(), row.tenant);
            }
        }
        out
    }
}

/// The set difference, both ways, between the companies a store holds and the
/// owner rows that claim them.
///
/// Pure and total, so the interesting part is testable without a database: the
/// callers do the two reads and hand the results here.
///
/// # What this deliberately does not do
///
/// **It does not compare tenants, and it does not group by them.** The question
/// is presence, not agreement: a row exists for this company or it does not.
/// Canonicalisation (`tenant:acme` vs bare `acme`, see
/// [`canonical_tenant`](crate::app::canonical_tenant)) only matters to code
/// that compares two tenant strings or buckets rows under one, and doing either
/// here would let the same tenant appear twice while answering a question
/// nobody asked. The tenant is reported verbatim so an operator sees the row as
/// it is actually persisted, which is what they will have to match when they
/// fix it.
///
/// **It does not care which tenant is running it.** This stays unfiltered on
/// purpose: a company orphaned from tenant B is exactly as invisible whether
/// tenant A or the platform is the one asking, and an operator running the
/// `opencompany orphans` command wants every tenant's findings in one answer.
/// The *boot* surface is a different decision — it filters to this workload's
/// own tenant before printing, because in shared-single-DB a tenant pod's
/// stderr is not the platform's log (`src/bin/opencompany.rs`). Filtering here
/// would do that job badly by hiding orphans from the one reader who can act on
/// them; filtering there is what keeps tenant B's ids out of tenant A's log.
pub fn find(companies: &[CompanySummary], owners: &[(CompanyId, String)]) -> OrphanReport {
    let owned: BTreeSet<&str> = owners.iter().map(|(id, _)| id.as_ref()).collect();
    // A `BTreeMap` rather than a set: a duplicate id in `companies` would
    // otherwise be reported twice, and the ordering is what makes the output
    // stable enough to diff between two boots.
    let present: BTreeMap<&str, &CompanySummary> =
        companies.iter().map(|c| (c.id.as_ref(), c)).collect();

    let unowned = present
        .values()
        .filter(|c| !owned.contains(c.id.as_ref()))
        .map(|c| UnownedCompany {
            id: c.id.clone(),
            name: c.name.clone(),
            lifecycle: c.lifecycle.clone(),
        })
        .collect();

    let mut dangling: Vec<DanglingOwner> = owners
        .iter()
        .filter(|(id, _)| !present.contains_key(id.as_ref()))
        .map(|(id, tenant)| DanglingOwner {
            id: id.clone(),
            tenant: tenant.clone(),
        })
        .collect();
    dangling.sort_by(|a, b| a.id.as_ref().cmp(b.id.as_ref()));

    OrphanReport { unowned, dangling }
}

/// Keep only the findings that belong to `tenant` — the *boot* filter.
///
/// A company's tenant lives in its id prefix (`<tenant>--`, written by
/// [`namespace_company_id`](crate::app::namespace_company_id)); a dangling
/// row's tenant is its persisted `tenant` field, compared canonically. The
/// [`find`] report is deliberately unfiltered so the `opencompany orphans`
/// command sees every tenant's findings in one answer; this is what a tenant
/// pod applies to its own boot warning, so tenant B's ids and tenant strings
/// never reach tenant A's stderr.
pub fn filter_to_tenant(report: OrphanReport, tenant: &str) -> OrphanReport {
    let prefix = format!("{tenant}--");
    let unowned = report
        .unowned
        .into_iter()
        .filter(|c| c.id.as_ref().starts_with(&prefix))
        .collect();
    let dangling = report
        .dangling
        .into_iter()
        .filter(|d| crate::app::canonical_tenant(&d.tenant) == crate::app::canonical_tenant(tenant))
        .collect();
    OrphanReport { unowned, dangling }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn company(id: &str) -> CompanySummary {
        CompanySummary {
            id: CompanyId::new(id.to_string()),
            name: format!("{id} Inc"),
            lifecycle: "active".to_string(),
        }
    }

    fn owner(id: &str, tenant: &str) -> (CompanyId, String) {
        (CompanyId::new(id.to_string()), tenant.to_string())
    }

    /// The finding this issue exists for: a company the store holds that no
    /// owner row claims. Its tenant gets a 403 from `authorize_address` and no
    /// explanation, so nothing but this report can tell anyone it is there.
    #[test]
    fn a_company_with_no_owner_row_is_reported() {
        let report = find(&[company("acme")], &[]);

        assert_eq!(report.unowned.len(), 1);
        assert_eq!(report.unowned[0].id.as_ref(), "acme");
        assert!(report.dangling.is_empty());
        assert!(!report.is_empty());
    }

    /// The other half of the same assertion, and the one that stops this being
    /// a function that reports everything. A healthy deployment must produce
    /// silence.
    #[test]
    fn a_company_with_an_owner_row_is_not_reported() {
        let report = find(&[company("acme")], &[owner("acme", "tenant-a")]);

        assert!(report.is_empty(), "{report:?}");
        assert_eq!(report.to_text(), "");
    }

    /// An owner row naming a company the store does not have. Benign, and
    /// reported separately from the unowned direction because the two mean
    /// opposite things to an operator: one hides data, the other is litter.
    #[test]
    fn an_owner_row_naming_no_company_is_reported_as_dangling() {
        let report = find(&[], &[owner("ghost", "tenant-b")]);

        assert!(report.unowned.is_empty());
        assert_eq!(report.dangling.len(), 1);
        assert_eq!(report.dangling[0].id.as_ref(), "ghost");
        assert_eq!(report.dangling[0].tenant, "tenant-b");
    }

    /// Both directions at once, which is the state an operator reconciling a
    /// shared database actually finds.
    #[test]
    fn both_directions_are_reported_together() {
        let report = find(
            &[company("acme"), company("beta")],
            &[owner("beta", "tenant-a"), owner("ghost", "tenant-b")],
        );

        assert_eq!(
            report
                .unowned
                .iter()
                .map(|c| c.id.as_ref())
                .collect::<Vec<_>>(),
            vec!["acme"]
        );
        assert_eq!(
            report
                .dangling
                .iter()
                .map(|r| r.id.as_ref())
                .collect::<Vec<_>>(),
            vec!["ghost"]
        );
    }

    /// Presence is the question, NOT agreement. A row that claims the company
    /// for a different tenant than the one asking still means the company is
    /// owned, and reporting it here would flood the report on every
    /// multi-tenant deployment — the normal state of the collection this reads.
    #[test]
    fn a_row_owned_by_another_tenant_is_still_owned() {
        let report = find(&[company("acme")], &[owner("acme", "some-other-tenant")]);

        assert!(report.is_empty(), "{report:?}");
    }

    /// The tenant is reported exactly as persisted, un-canonicalised.
    ///
    /// `canonical_tenant` maps `tenant:acme` and bare `acme` together, and
    /// hydration needs that because it compares two tenant strings. This does
    /// not compare anything, and an operator about to go and fix a row needs to
    /// see the bytes that are actually in it.
    #[test]
    fn the_dangling_tenant_is_reported_verbatim() {
        let report = find(&[], &[owner("ghost", "tenant:acme")]);

        assert_eq!(report.dangling[0].tenant, "tenant:acme");
    }

    /// Output order does not track the order the two backends happened to
    /// return rows in, so two boots of an unchanged deployment produce
    /// identical text and a diff between them means something moved.
    #[test]
    fn findings_are_ordered_independently_of_the_input_order() {
        let forward = find(
            &[company("zeta"), company("alpha")],
            &[owner("z-ghost", "t"), owner("a-ghost", "t")],
        );
        let reversed = find(
            &[company("alpha"), company("zeta")],
            &[owner("a-ghost", "t"), owner("z-ghost", "t")],
        );

        assert_eq!(forward, reversed);
        assert_eq!(
            forward
                .unowned
                .iter()
                .map(|c| c.id.as_ref())
                .collect::<Vec<_>>(),
            vec!["alpha", "zeta"]
        );
        assert_eq!(
            forward
                .dangling
                .iter()
                .map(|r| r.id.as_ref())
                .collect::<Vec<_>>(),
            vec!["a-ghost", "z-ghost"]
        );
    }

    /// A duplicate id from the company store is reported once, not twice.
    #[test]
    fn a_duplicated_company_id_is_reported_once() {
        let report = find(&[company("acme"), company("acme")], &[]);

        assert_eq!(report.unowned.len(), 1);
    }

    /// The text names every finding. A report that says "3 companies" without
    /// saying which is not actionable, and the ids are the whole point.
    #[test]
    fn the_text_names_every_finding() {
        let report = find(&[company("acme")], &[owner("ghost", "tenant-b")]);
        let text = report.to_text();

        assert!(text.contains("acme"), "{text}");
        assert!(text.contains("ghost"), "{text}");
        assert!(text.contains("tenant-b"), "{text}");
    }

    /// The boot filter keeps only this tenant's unowned companies — identified
    /// by the `<tenant>--` id prefix `namespace_company_id` writes — and drops
    /// the rest, so tenant B's company ids never reach tenant A's boot log.
    #[test]
    fn the_boot_filter_keeps_only_this_tenants_companies() {
        let report = find(&[company("tenant-a--acme"), company("tenant-b--beta")], &[]);
        let filtered = filter_to_tenant(report, "tenant-a");

        let ids: Vec<&str> = filtered.unowned.iter().map(|c| c.id.as_ref()).collect();
        assert_eq!(ids, vec!["tenant-a--acme"]);
        assert!(filtered.dangling.is_empty());
    }

    /// A company with no tenant prefix is nobody's in the shared database, so
    /// the boot filter drops it too. Such a company is addressable with
    /// platform scope, not orphaned from a tenant.
    #[test]
    fn the_boot_filter_drops_unprefixed_companies() {
        let report = find(&[company("acme")], &[]);
        let filtered = filter_to_tenant(report, "tenant-a");

        assert!(filtered.is_empty(), "{filtered:?}");
    }

    /// Dangling rows are matched by their persisted tenant, compared
    /// canonically (`tenant:acme` and `acme` are one tenant), so the boot
    /// filter keeps this tenant's litter and drops everyone else's.
    #[test]
    fn the_boot_filter_keeps_this_tenants_dangling_rows() {
        let report = find(
            &[],
            &[
                owner("tenant-a--ghost", "tenant:acme"),
                owner("tenant-b--ghost", "tenant-b"),
            ],
        );
        let filtered = filter_to_tenant(report, "acme");

        let ids: Vec<&str> = filtered.dangling.iter().map(|r| r.id.as_ref()).collect();
        assert_eq!(ids, vec!["tenant-a--ghost"]);
        assert!(filtered.unowned.is_empty());
    }
}
