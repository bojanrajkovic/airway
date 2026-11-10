// Checks the built image, not the source: that it starts with only its production dependencies,
// runs the way the pod does, and serves the web build. Everything else is covered by the unit and
// browser tests against the source.
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, describe, expect, it } from "vitest";

const image = process.env["AIRWAY_IMAGE"];

if (image === undefined || image === "") {
  throw new Error("AIRWAY_IMAGE must name the image to test, such as localhost/airway:dev");
}

/** testcontainers has no setting for a read-only root filesystem, which the pod uses. */
class ReadOnlyContainer extends GenericContainer {
  constructor(name: string) {
    super(name);
    this.hostConfig.ReadonlyRootfs = true;
  }
}

const container = await new ReadOnlyContainer(image)
  // The image's own user, which the pod runs as.
  .withUser("65532:65532")
  .withTmpFs({ "/tmp": "rw" })
  .withEnvironment({
    // The pools connect lazily, so nothing here reaches a database.
    DATABASE_URL: "postgres://airway:airway@127.0.0.1:5432/airway",
    AIRWAY_READER_DATABASE_URL: "postgres://airway_reader:airway@127.0.0.1:5432/airway",
    AIRWAY_PATIENT_NAME: "Sample Patient",
    AIRWAY_PATIENT_BIRTH_DATE: "2015-03-14",
    AIRWAY_CLOCK_OFFSETS: '[{"from":"2025-01-01","utcOffset":"-05:00"}]',
    AIRWAY_TIME_ZONE: "America/Chicago",
    AIRWAY_CPAP_DATA_PATH: "/tmp/cpap-data",
    AIRWAY_AUTH: "none",
    AIRWAY_LOCAL_AUTHOR_NAME: "Sample Person",
    AIRWAY_LOCAL_AUTHOR_EMAIL: "sample@example.test",
  })
  .withExposedPorts(3000)
  .withWaitStrategy(Wait.forHttp("/healthz", 3000))
  .start();
const base = `http://${container.getHost()}:${String(container.getMappedPort(3000))}`;

afterAll(async () => {
  await container.stop();
});

describe("the image", () => {
  it("answers the health check", async () => {
    const response = await fetch(`${base}/healthz`);

    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the page with its CSP and the script it loads", async () => {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    const script = /<script[^>]+src="(?<src>[^"]+)"/v.exec(html)?.groups?.["src"];

    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(script).toMatch(/^\/assets\//v);

    const asset = await fetch(`${base}${script ?? ""}`);

    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
  });
});
