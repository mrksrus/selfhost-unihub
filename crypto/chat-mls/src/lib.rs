//! The MLS calls Chat makes, over OpenMLS, for the page (wasm-bindgen).
//!
//! A device's whole state lives in OpenMLS's in-memory store. The page keeps
//! it: `changes()` hands out the entries an operation wrote or deleted, and a
//! fresh `Device` gets them back with `put()`. A group never changes after it
//! is made, so there are no commits to send or merge.

use std::collections::HashMap;

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
// Our own entry beside OpenMLS's: the signature public key, then the credential identity.
const IDENTITY: &[u8] = b"unihub/identity";

// Errors reach the page as thrown strings: a JsError cannot be made outside the browser, where the tests run.
type Result<T> = std::result::Result<T, String>;

fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// One storage entry an operation changed; no value means it was deleted.
#[wasm_bindgen(getter_with_clone)]
pub struct Entry {
    pub key: Vec<u8>,
    pub value: Option<Vec<u8>>,
}

#[wasm_bindgen]
pub struct Device {
    provider: OpenMlsRustCrypto,
    // The entries as the page last received them, to tell what changed since.
    saved: HashMap<Vec<u8>, Vec<u8>>,
}

#[wasm_bindgen]
impl Device {
    /// An empty device, to be filled with `put()` from stored entries.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Device {
        Device { provider: OpenMlsRustCrypto::default(), saved: HashMap::new() }
    }

    /// A device with a new signature key; `name` is its credential's identity.
    pub fn create(name: &[u8]) -> Result<Device> {
        let device = Device::new();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).map_err(fail)?;
        signer.store(device.provider.storage()).map_err(fail)?;
        let mut identity = signer.to_public_vec();
        identity.extend_from_slice(name);
        device.values().insert(IDENTITY.to_vec(), identity);
        Ok(device)
    }

    /// Puts back one entry that `changes()` handed out earlier.
    pub fn put(&mut self, key: &[u8], value: &[u8]) {
        self.values().insert(key.to_vec(), value.to_vec());
        self.saved.insert(key.to_vec(), value.to_vec());
    }

    /// The entries written or deleted since the last call (or since `put`).
    pub fn changes(&mut self) -> Vec<Entry> {
        let now = self.values().clone();
        let mut changed: Vec<Entry> = now
            .iter()
            .filter(|(key, value)| self.saved.get(*key) != Some(*value))
            .map(|(key, value)| Entry { key: key.clone(), value: Some(value.clone()) })
            .collect();
        changed.extend(self.saved.keys().filter(|key| !now.contains_key(*key)).map(|key| Entry { key: key.clone(), value: None }));
        self.saved = now;
        changed
    }

    /// A new key package (TLS-encoded), for someone to put this device into a group.
    pub fn key_package(&mut self) -> Result<Vec<u8>> {
        let (signer, credential) = self.identity()?;
        let bundle = KeyPackage::builder().build(SUITE, &self.provider, &signer, credential).map_err(fail)?;
        bundle.key_package().tls_serialize_detached().map_err(fail)
    }

    /// Makes group `group_id` with this device and the devices of the
    /// concatenated key packages, and returns the one Welcome for all of them.
    pub fn create_group(&mut self, group_id: &[u8], key_packages: &[u8]) -> Result<Vec<u8>> {
        let (signer, credential) = self.identity()?;
        let mut members = Vec::new();
        let mut rest = key_packages;
        while !rest.is_empty() {
            let package = KeyPackageIn::tls_deserialize(&mut rest).map_err(fail)?;
            members.push(package.validate(self.provider.crypto(), ProtocolVersion::Mls10).map_err(fail)?);
        }
        let mut group = MlsGroup::builder()
            .ciphersuite(SUITE)
            .with_group_id(GroupId::from_slice(group_id))
            .use_ratchet_tree_extension(true)
            .build(&self.provider, &signer, credential)
            .map_err(fail)?;
        let (_commit, welcome, _info) = group.add_members(&self.provider, &signer, &members).map_err(fail)?;
        group.merge_pending_commit(&self.provider).map_err(fail)?;
        welcome.tls_serialize_detached().map_err(fail)
    }

    /// Joins the group of a Welcome and returns its group id.
    pub fn join(&mut self, welcome: &[u8]) -> Result<Vec<u8>> {
        let welcome = match MlsMessageIn::tls_deserialize_exact(welcome).map_err(fail)?.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err("not a Welcome".into()),
        };
        let group = StagedWelcome::new_from_welcome(&self.provider, &MlsGroupJoinConfig::default(), welcome, None)
            .and_then(|staged| staged.into_group(&self.provider))
            .map_err(fail)?;
        Ok(group.group_id().as_slice().to_vec())
    }

    /// Encrypts an application message to the group.
    pub fn encrypt(&mut self, group_id: &[u8], text: &[u8]) -> Result<Vec<u8>> {
        let (signer, _) = self.identity()?;
        let mut group = self.group(group_id)?;
        let message = group.create_message(&self.provider, &signer, text).map_err(fail)?;
        message.tls_serialize_detached().map_err(fail)
    }

    /// Decrypts an application message of another member of the group.
    pub fn decrypt(&mut self, group_id: &[u8], message: &[u8]) -> Result<Vec<u8>> {
        let mut group = self.group(group_id)?;
        let message = MlsMessageIn::tls_deserialize_exact(message).map_err(fail)?;
        let message = message.try_into_protocol_message().map_err(fail)?;
        match group.process_message(&self.provider, message).map_err(fail)?.into_content() {
            ProcessedMessageContent::ApplicationMessage(text) => Ok(text.into_bytes()),
            _ => Err("not an application message".into()),
        }
    }
}

impl Default for Device {
    fn default() -> Self {
        Device::new()
    }
}

impl Device {
    fn values(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<Vec<u8>, Vec<u8>>> {
        self.provider.storage().values.write().expect("storage lock")
    }

    fn identity(&self) -> Result<(SignatureKeyPair, CredentialWithKey)> {
        let stored = self.values().get(IDENTITY).cloned().ok_or("no device identity")?;
        let (public, name) = stored.split_at(32);
        let signer = SignatureKeyPair::read(self.provider.storage(), public, SUITE.signature_algorithm())
            .ok_or("no signature key")?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(name.to_vec()).into(),
            signature_key: public.into(),
        };
        Ok((signer, credential))
    }

    fn group(&self, group_id: &[u8]) -> Result<MlsGroup> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(fail)?
            .ok_or_else(|| "unknown group".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // What the page does at a reload: a new device from every entry handed out so far.
    fn reload(store: &mut HashMap<Vec<u8>, Vec<u8>>, device: &mut Device) -> Device {
        for entry in device.changes() {
            match entry.value {
                Some(value) => store.insert(entry.key, value),
                None => store.remove(&entry.key),
            };
        }
        let mut fresh = Device::new();
        for (key, value) in store.iter() {
            fresh.put(key, value);
        }
        fresh
    }

    #[test]
    fn three_devices_exchange_messages_and_one_survives_a_reload() {
        let mut alex = Device::create(b"alex-1").unwrap();
        let mut blair = Device::create(b"blair-1").unwrap();
        let mut blair2 = Device::create(b"blair-2").unwrap();
        let packages = [blair.key_package().unwrap(), blair2.key_package().unwrap()].concat();
        let welcome = alex.create_group(b"group-1", &packages).unwrap();
        assert_eq!(blair.join(&welcome).unwrap(), b"group-1");
        assert_eq!(blair2.join(&welcome).unwrap(), b"group-1");

        let hello = alex.encrypt(b"group-1", b"hello").unwrap();
        assert_eq!(blair.decrypt(b"group-1", &hello).unwrap(), b"hello");
        assert_eq!(blair2.decrypt(b"group-1", &hello).unwrap(), b"hello");
        let reply = blair2.encrypt(b"group-1", b"hi alex").unwrap();
        assert_eq!(alex.decrypt(b"group-1", &reply).unwrap(), b"hi alex");
        assert_eq!(blair.decrypt(b"group-1", &reply).unwrap(), b"hi alex");

        let mut stored = HashMap::new();
        let mut blair = reload(&mut stored, &mut blair);
        let later = alex.encrypt(b"group-1", b"after the reload").unwrap();
        assert_eq!(blair.decrypt(b"group-1", &later).unwrap(), b"after the reload");
        // The reloaded device sends too, and its new entries are handed out again.
        let back = blair.encrypt(b"group-1", b"still here").unwrap();
        assert!(!blair.changes().is_empty());
        assert_eq!(alex.decrypt(b"group-1", &back).unwrap(), b"still here");
    }

    #[test]
    fn a_device_outside_the_group_cannot_read_it() {
        let mut alex = Device::create(b"alex-1").unwrap();
        let mut blair = Device::create(b"blair-1").unwrap();
        let mut casey = Device::create(b"casey-1").unwrap();
        let welcome = alex.create_group(b"group-2", &blair.key_package().unwrap()).unwrap();
        blair.join(&welcome).unwrap();
        assert!(casey.join(&welcome).is_err());
        let secret = alex.encrypt(b"group-2", b"only for blair").unwrap();
        assert!(casey.decrypt(b"group-2", &secret).is_err());
        assert_eq!(blair.decrypt(b"group-2", &secret).unwrap(), b"only for blair");
    }

    #[test]
    fn changes_report_deleted_entries() {
        let mut alex = Device::create(b"alex-1").unwrap();
        let mut blair = Device::create(b"blair-1").unwrap();
        blair.key_package().unwrap();
        blair.changes();
        // Joining consumes the key package: its private part is deleted.
        let welcome = alex.create_group(b"group-3", &blair.key_package().unwrap()).unwrap();
        blair.changes();
        blair.join(&welcome).unwrap();
        assert!(blair.changes().iter().any(|entry| entry.value.is_none()));
    }
}
