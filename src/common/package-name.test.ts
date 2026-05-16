import { describe, it, expect } from "vitest";
import { extractPackageFromManifest, extractPackageFromGradleKts, extractPackageFromGradle } from "./package-name.js";

describe("extractPackageFromManifest", () => {
  it("extracts package from AndroidManifest.xml", () => {
    const xml = '<manifest package="com.example.myapp"><application/></manifest>';
    expect(extractPackageFromManifest(xml)).toBe("com.example.myapp");
  });

  it("returns null when package attribute is missing", () => {
    const xml = "<manifest><application/></manifest>";
    expect(extractPackageFromManifest(xml)).toBeNull();
  });

  it("handles multi-line manifest", () => {
    const xml = `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.pi.extension.test_app">
  <application />
</manifest>`;
    expect(extractPackageFromManifest(xml)).toBe("com.pi.extension.test_app");
  });
});

describe("extractPackageFromGradleKts", () => {
  it("extracts applicationId with double quotes", () => {
    const content = 'android { defaultConfig { applicationId = "com.example.app" } }';
    expect(extractPackageFromGradleKts(content)).toBe("com.example.app");
  });

  it("extracts applicationId with single quotes", () => {
    const content = "android { defaultConfig { applicationId = 'com.example.app' } }";
    expect(extractPackageFromGradleKts(content)).toBe("com.example.app");
  });

  it("falls back to namespace when applicationId is missing", () => {
    const content = 'android { namespace = "com.example.app" }';
    expect(extractPackageFromGradleKts(content)).toBe("com.example.app");
  });

  it("prefers applicationId over namespace", () => {
    const content = 'android { namespace = "com.example.ns"; defaultConfig { applicationId = "com.example.app" } }';
    expect(extractPackageFromGradleKts(content)).toBe("com.example.app");
  });

  it("returns null when neither is present", () => {
    const content = "android { compileSdk = 34 }";
    expect(extractPackageFromGradleKts(content)).toBeNull();
  });
});

describe("extractPackageFromGradle", () => {
  it("extracts applicationId with double quotes", () => {
    const content = 'android { defaultConfig { applicationId "com.example.app" } }';
    expect(extractPackageFromGradle(content)).toBe("com.example.app");
  });

  it("extracts applicationId with single quotes", () => {
    const content = "android { defaultConfig { applicationId 'com.example.app' } }";
    expect(extractPackageFromGradle(content)).toBe("com.example.app");
  });

  it("extracts applicationId without quotes", () => {
    const content = "android { defaultConfig { applicationId com.example.app } }";
    expect(extractPackageFromGradle(content)).toBe("com.example.app");
  });

  it("falls back to namespace", () => {
    const content = 'android { namespace "com.example.app" }';
    expect(extractPackageFromGradle(content)).toBe("com.example.app");
  });

  it("returns null when neither is present", () => {
    const content = "android { compileSdk 34 }";
    expect(extractPackageFromGradle(content)).toBeNull();
  });
});
