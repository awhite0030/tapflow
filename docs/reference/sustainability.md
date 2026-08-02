# Sustainability

tapflow makes better use of the Macs a team already owns and lowers the need for new hardware, which makes mobile QA more sustainable.

A significant share of a phone or laptop's carbon is emitted during manufacturing rather than during use, as Apple's own [product environmental reports](https://www.apple.com/environment/reports/) show. This is embodied carbon, and [Software Carbon Intensity (SCI)](https://sci.greensoftware.foundation/), now an international standard, weighs it alongside energy consumption. Keeping existing hardware in service longer and buying fewer new devices can therefore help reduce the burden from manufacturing.

## Using Macs you already have

tapflow turns Macs that a team already owns, but does not use continuously, into shared QA infrastructure. Instead of building out a device farm or a dedicated test server, you make better use of hardware you already own.

## Less reliance on physical devices

Maintaining coverage across OS versions usually means keeping several devices and pinning each one to a specific version. On iOS this is especially common, since rolling back to an earlier version is effectively impossible. Simulators and emulators give you the same OS coverage without additional devices.

Simulators alone, though, do not carry that benefit across a team — only people with a development environment installed can use them. tapflow shares simulators and emulators through a browser, so PMs, designers, and backend engineers without a mobile development environment can work in the same test environment. That can reduce the need to add physical devices at the team level.

## Extending hardware lifetime

When new machines are issued, the ones they replace are left over. Running one as an agent host keeps it in service instead of sending it for disposal. A simulator host often depends more on having enough memory than on CPU speed, so a Mac a generation or two behind can still handle the role reliably.

## Limits

- **It draws power.** A Mac left on running simulators consumes electricity.
- **It does not replace every physical device.** tapflow cannot test features that depend on device hardware, such as camera, NFC, or biometrics.
- **Old Macs have a floor.** The iOS simulator requires a recent Xcode, which requires a recent macOS. A Mac past that line cannot run as an agent. See [Requirements](/guide/requirements).
