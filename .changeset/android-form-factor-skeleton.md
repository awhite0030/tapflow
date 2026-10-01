---
"@tapflowio/android-agent": patch
"@tapflowio/relay": patch
---

The Android agent reports each AVD's form factor, read from its config.ini at register: a hinge with a tablet-sized unfolded screen is `foldable`, a smallest width of 600 dp or more is `tablet`, otherwise `phone`. A flip folds to a phone and is reported as one, a resizable AVD is read by its screen, and a TV, Wear, desktop or automotive image reports none. The AVD is looked up where the emulator looks for it. The boot skeleton takes the device's shape: a phone, an iPad or a foldable upright, or an Android tablet on its side.
