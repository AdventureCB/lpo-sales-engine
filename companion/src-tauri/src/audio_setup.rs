// One-click audio setup: create the "Mic + VM" aggregate input device
// (default mic + BlackHole 2ch) that Quo uses as its microphone. Uses the
// documented CoreAudio aggregate-device dictionary keys.

#![cfg(target_os = "macos")]

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use coreaudio_sys::{
    kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultInputDevice,
    kAudioHardwarePropertyDevices, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioDeviceID, AudioHardwareCreateAggregateDevice, AudioHardwareDestroyAggregateDevice,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress, CFStringRef,
};
use std::mem;
use std::ptr;

const AGG_NAME: &str = "Mic + VM";
const AGG_UID: &str = "com.lonepeakoverland.mic-vm-aggregate";

fn prop_addr(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

fn string_prop(id: AudioObjectID, selector: u32) -> Option<String> {
    let addr = prop_addr(selector);
    let mut cf: CFStringRef = ptr::null();
    let mut size = mem::size_of::<CFStringRef>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(id, &addr, 0, ptr::null(), &mut size, &mut cf as *mut _ as *mut _)
    };
    if status != 0 || cf.is_null() {
        return None;
    }
    let s = unsafe { CFString::wrap_under_create_rule(cf as *const _) };
    Some(s.to_string())
}

fn all_devices() -> Vec<AudioDeviceID> {
    let addr = prop_addr(kAudioHardwarePropertyDevices);
    let mut size: u32 = 0;
    unsafe {
        if AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, ptr::null(), &mut size) != 0 {
            return vec![];
        }
        let count = size as usize / mem::size_of::<AudioDeviceID>();
        let mut ids = vec![0 as AudioDeviceID; count];
        if AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &addr, 0, ptr::null(), &mut size,
            ids.as_mut_ptr() as *mut _,
        ) != 0 {
            return vec![];
        }
        ids
    }
}

pub fn create_mic_vm_aggregate() -> Result<String, String> {
    // default input mic
    let addr = prop_addr(kAudioHardwarePropertyDefaultInputDevice);
    let mut mic_id: AudioDeviceID = 0;
    let mut size = mem::size_of::<AudioDeviceID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &addr, 0, ptr::null(), &mut size,
            &mut mic_id as *mut _ as *mut _,
        )
    };
    if status != 0 || mic_id == 0 {
        return Err("no default input device found".into());
    }
    let mic_uid = string_prop(mic_id, kAudioDevicePropertyDeviceUID)
        .ok_or("could not read microphone UID")?;
    let mic_name = string_prop(mic_id, kAudioObjectPropertyName).unwrap_or_else(|| "mic".into());

    // find BlackHole + destroy any previous aggregate of ours (idempotent)
    let mut blackhole_uid: Option<String> = None;
    for id in all_devices() {
        if let Some(uid) = string_prop(id, kAudioDevicePropertyDeviceUID) {
            if uid == AGG_UID {
                unsafe { AudioHardwareDestroyAggregateDevice(id) };
                continue;
            }
        }
        if let Some(name) = string_prop(id, kAudioObjectPropertyName) {
            if name.contains("BlackHole") {
                blackhole_uid = string_prop(id, kAudioDevicePropertyDeviceUID);
            }
        }
    }
    let blackhole_uid =
        blackhole_uid.ok_or("BlackHole 2ch not found — install it first (existential.audio/blackhole)")?;

    // documented aggregate-device dictionary keys ("name"/"uid"/"subdevices"/"master"/"drift")
    let sub_mic: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[(
        CFString::new("uid"),
        CFString::new(&mic_uid).as_CFType(),
    )]);
    let sub_bh: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[
        (CFString::new("uid"), CFString::new(&blackhole_uid).as_CFType()),
        (CFString::new("drift"), CFNumber::from(1i32).as_CFType()),
    ]);
    let subdevices = CFArray::from_CFTypes(&[sub_mic.as_CFType(), sub_bh.as_CFType()]);
    let desc: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[
        (CFString::new("name"), CFString::new(AGG_NAME).as_CFType()),
        (CFString::new("uid"), CFString::new(AGG_UID).as_CFType()),
        (CFString::new("subdevices"), subdevices.as_CFType()),
        (CFString::new("master"), CFString::new(&mic_uid).as_CFType()),
    ]);

    let mut agg_id: AudioDeviceID = 0;
    let status = unsafe {
        AudioHardwareCreateAggregateDevice(
            desc.as_concrete_TypeRef() as *const _,
            &mut agg_id,
        )
    };
    if status != 0 {
        return Err(format!("aggregate creation failed (OSStatus {status})"));
    }
    Ok(format!("Created '{AGG_NAME}' ({mic_name} + BlackHole 2ch). Set Quo's microphone to it."))
}
