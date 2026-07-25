//! The [`CompanyStore`] port: durable company records.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use async_trait::async_trait;

use crate::Result;
use crate::ports::types::{CompanyId, CompanyRecord, CompanySummary, LedgerEntry};

/// Durable company records: charter, roster, ledger, approval queue.
#[async_trait]
pub trait CompanyStore: Send + Sync {
    /// Loads a company record, or `None` if it does not exist.
    async fn load(&self, id: &CompanyId) -> Result<Option<CompanyRecord>>;
    /// Persists a company record.
    async fn save(&self, record: &CompanyRecord) -> Result<()>;
    /// Lists all known companies.
    async fn list(&self) -> Result<Vec<CompanySummary>>;
    /// Appends one entry to a company's ledger.
    async fn append_ledger(&self, id: &CompanyId, entry: LedgerEntry) -> Result<()>;
}

/// Per-company write serialization: a shared mutex map, keyed by company id, so
/// the orchestrator's `add_agent` tool and the console `POST .../team` route can
/// never clobber each other's `overlay_agents` list with concurrent
/// load→push→save cycles.
static COMPANY_WRITE_LOCKS: LazyLock<Mutex<HashMap<CompanyId, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Returns (or creates) the per-company write mutex for `company`, so callers
/// that do a `CompanyStore` load→mutate→save cycle can serialise their writes
/// against other concurrent writers.
pub(crate) fn company_write_lock(company: &CompanyId) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = COMPANY_WRITE_LOCKS.lock().expect("company write locks");
    map.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = map.get(company).and_then(Weak::upgrade) {
        return lock;
    }

    let lock = Arc::new(tokio::sync::Mutex::new(()));
    map.insert(company.clone(), Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_write_lock_reaps_inactive_company_entries() {
        let inactive = CompanyId::new(format!("inactive-{}", crate::ports::generate_id()));
        let trigger = CompanyId::new(format!("trigger-{}", crate::ports::generate_id()));

        let lock = company_write_lock(&inactive);
        assert!(Arc::ptr_eq(&lock, &company_write_lock(&inactive)));
        drop(lock);

        let _trigger_lock = company_write_lock(&trigger);
        let map = COMPANY_WRITE_LOCKS.lock().expect("company write locks");
        assert!(!map.contains_key(&inactive));
    }
}
