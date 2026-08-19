pub mod boot;
pub mod config;
pub mod doctor;
pub mod instance;
pub mod journal;
pub mod orphans;
mod types;

pub use boot::{EmbeddedInstance, prepare_instance};
pub use config::{BrainMode, ConfigProvenance, RuntimeConfig, resolve};
pub use doctor::{DoctorReport, report as doctor_report};
pub use orphans::{
    DanglingOwner, OrphanReport, UnownedCompany, filter_to_tenant, find as find_orphans,
};
pub use types::{
    AppConfig, AppSpec, AppState, canonical_tenant, namespace_company_id, validate_tenant_namespace,
};
