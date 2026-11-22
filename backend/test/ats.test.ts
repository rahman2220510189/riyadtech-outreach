import { describe, expect, it } from "vitest";
import { detectBoard, htmlToText, jobsAsPageText, type JobBoard, parseJobs, realFeedUrl } from "../src/crawler/ats.js";
import { isDeveloperRole } from "../src/crawler/signals.js";

const board = (provider: JobBoard["provider"], slug = "acme"): JobBoard => ({ provider, slug, ...realFeedUrl({ provider, slug }) });

describe("job platforms", () => {
  it("finds the platform in links and embed scripts", () => {
    expect(detectBoard(['<a href="https://acme-gmbh.jobs.personio.de/">Jobs</a>'])).toMatchObject({
      provider: "personio",
      slug: "acme-gmbh",
      feedUrl: "https://acme-gmbh.jobs.personio.de/xml?language=en",
    });
    expect(detectBoard(['<a href="https://acme.jobs.personio.com/">Jobs</a>'])?.feedUrl).toBe("https://acme.jobs.personio.com/xml?language=en");
    expect(detectBoard(['<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeco"></script>'])?.slug).toBe("acmeco");
    expect(detectBoard(['<a href="https://job-boards.greenhouse.io/acmeco/jobs/123">x</a>'])?.slug).toBe("acmeco");
    expect(detectBoard(['<a href="https://jobs.lever.co/acme">x</a>'])).toMatchObject({ provider: "lever", feedUrl: "https://api.lever.co/v0/postings/acme?mode=json" });
    expect(detectBoard(['<a href="https://acme.recruitee.com/o/dev">x</a>'])?.provider).toBe("recruitee");
    expect(detectBoard(['<a href="https://apply.workable.com/acme/">x</a>'])?.provider).toBe("workable");
    expect(detectBoard(['<a href="https://jobs.smartrecruiters.com/AcmeGroup">x</a>'])).toMatchObject({ provider: "smartrecruiters", slug: "acmegroup" });
    expect(detectBoard(['<a href="https://boards.greenhouse.io/embed/">x</a>', "<p>no board</p>"])).toBeNull();
  });

  it("reads Personio XML (titles, office, job links, text)", () => {
    const xml = `<?xml version="1.0"?><workzag-jobs>
      <position><id>101</id><office>Berlin</office><name>Senior Backend Engineer (m/w/d)</name><schedule>full-time</schedule>
        <jobDescriptions><jobDescription><name>About</name><value><![CDATA[<p>Our team language is English. Remote possible.</p>]]></value></jobDescription></jobDescriptions></position>
      <position><id>102</id><office>Remote</office><name>Office Manager (m/w/d)</name></position>
    </workzag-jobs>`;
    const jobs = parseJobs(board("personio"), xml);
    expect(jobs.map((j) => [j.title, j.url, j.location, j.remote])).toEqual([
      ["Senior Backend Engineer (m/w/d)", "https://acme.jobs.personio.de/job/101", "Berlin", false],
      ["Office Manager (m/w/d)", "https://acme.jobs.personio.de/job/102", "Remote", true],
    ]);
    expect(jobs[0]!.text).toBe("Our team language is English. Remote possible.");
  });

  it("reads Greenhouse, Lever, Recruitee, Workable and SmartRecruiters JSON; bad feeds give no jobs", () => {
    expect(parseJobs(board("greenhouse"), JSON.stringify({ jobs: [{ title: "Frontend Developer", absolute_url: "https://g/1", location: { name: "Remote, EU" }, content: "&lt;p&gt;React&lt;/p&gt;" }] })))
      .toEqual([{ title: "Frontend Developer", url: "https://g/1", location: "Remote, EU", remote: true, text: "React" }]);
    expect(parseJobs(board("lever"), JSON.stringify([{ text: "Python Engineer", hostedUrl: "https://l/1", categories: { location: "Amsterdam" }, workplaceType: "remote", descriptionPlain: "Django" }]))[0])
      .toMatchObject({ title: "Python Engineer", remote: true, location: "Amsterdam" });
    expect(parseJobs(board("recruitee"), JSON.stringify({ offers: [{ title: "Full Stack Developer", careers_url: "https://r/1", location: "Warsaw", remote: false }] }))[0]?.title).toBe("Full Stack Developer");
    expect(parseJobs(board("workable"), JSON.stringify({ jobs: [{ title: "DevOps Engineer", url: "https://w/1", city: "Paris", country: "France", telecommuting: true }] }))[0])
      .toMatchObject({ location: "Paris, France", remote: true });
    expect(parseJobs(board("smartrecruiters"), JSON.stringify({ content: [{ id: "77", name: "Java Developer", location: { city: "Munich", remote: false } }] }))[0])
      .toMatchObject({ title: "Java Developer", url: "https://jobs.smartrecruiters.com/acme/77" });
    expect(parseJobs(board("greenhouse"), "<html>not json</html>")).toEqual([]);
    expect(parseJobs(board("lever"), JSON.stringify({ error: "x" }))).toEqual([]);
  });

  it("keeps developer roles only, and turns them into careers-page text", () => {
    expect(isDeveloperRole("Senior Backend Engineer (m/w/d)")).toBe(true);
    expect(isDeveloperRole("Werkstudent Softwareentwickler (m/w/d)")).toBe(true);
    expect(isDeveloperRole("Office Manager (m/w/d)")).toBe(false);
    expect(isDeveloperRole("Sales Engineer")).toBe(false);
    const text = jobsAsPageText("personio", [{ title: "Backend Engineer", url: "u", location: "Berlin", remote: true, text: "Node.js" }]);
    expect(text).toBe("We're hiring (Personio): Backend Engineer (Berlin) - remote possible. Node.js");
    expect(htmlToText("<b>a</b>&amp;<i>b</i>")).toBe("a & b");
  });
});
