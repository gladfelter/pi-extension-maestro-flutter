# Emulator management

| Task                     | Command                                                             | When to use                                             |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------- |
| List available emulators | `flutter emulators`                                                 | Before `flutter_connect` to find AVD names              |
| Launch emulator (WSL2)   | `sg kvm -c "emulator -avd test_34 ..."`                             | Before `flutter_connect` if no device                   |
| Wait for boot completion | `adb shell getprop sys.boot_completed`                              | After launching emulator                                |
| Check KVM access         | `cat /dev/kvm > /dev/null 2>&1 && echo "KVM OK" \|\| echo "No KVM"` | If emulator errors out with message about kvm problems. |

```bash
# Example: Launch emulator and wait for it to be ready
sg kvm -c "
  $HOME/android-sdk/emulator/emulator \
    -avd test_34 \
    -no-boot-anim \
    -netdelay none \
    -netspeed full \
    -memory 2048 \
    -cores 4 \
    > /tmp/emulator.log 2>&1 &
"
```