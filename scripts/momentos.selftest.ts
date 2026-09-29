import { ANDHRA_PRADESH_MOMENTO_TEACHERS } from "../src/data/andhraPradeshMomentoTeachers";
import { TAMIL_NADU_MOMENTO_TEACHERS } from "../src/data/tamilNaduMomentoTeachers";
import { UTTAR_PRADESH_MOMENTO_TEACHERS } from "../src/data/uttarPradeshMomentoTeachers";
import { MOMENTO_TEACHERS } from "../src/data/momentoTeachers";
import { TELANGANA_MOMENTO_TEACHERS } from "../src/data/telanganaMomentoTeachers";
import { buildMomentoRows } from "../src/lib/momentos";
import type { MomentoTeacher } from "../src/data/karnatakaMomentoTeachers";

const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

const roster: MomentoTeacher[] = [
  { name: "G KAVITHA", phone: "9535397094", region: "Karnataka" },
  { name: "Dr Bhurli Prahlad", phone: "", region: "Karnataka" },
  { name: "Unmatched Teacher", phone: "9000000001", region: "Karnataka" },
];

const rows = buildMomentoRows(
  roster,
  [
    { _id: "nom-1", phone: "9535397094", status: "pending" },
    { _id: "nom-2", phone: "919535397094", status: "winner" },
    { _id: "draft-1", phone: "9535397094", status: "draft" },
  ],
  [
    {
      nomination_id: "nom-1",
      category_icon_filename: "knowledge-icon.svg",
      video_url: "https://example.com/n1.mp4",
      generation_status: "generated",
      generated_at: "2026-09-01T00:00:00.000Z",
    },
    {
      nomination_id: "nom-2",
      category_icon_filename: "motivation-icon.svg",
      video_url: "https://example.com/n2.mp4",
      generation_status: "generated",
      generated_at: "2026-09-02T00:00:00.000Z",
    },
  ]
);

assert(rows.length === 3, "should keep one row per roster teacher");

const kavitha = rows[0];
assert(kavitha.name === "G KAVITHA", "first row should be the provided teacher");
assert(kavitha.matched === true, "phone should match submitted nominations");
assert(kavitha.video_count === 2, "should count every generated video for that phone");
assert(kavitha.momentos.length === 1, "each teacher should have one momento");
assert(
  JSON.stringify(kavitha.momentos) === JSON.stringify(["motivation icon"]),
  `one momento from the latest stored icon, got ${JSON.stringify(kavitha.momentos)}`
);
assert(
  kavitha.videos.every((video) => video.category_icon_label !== "Not selected"),
  "stored icons must not fall back to a random or empty pick"
);

const noPhone = rows[1];
assert(noPhone.matched === false, "teacher without a phone stays unmatched");
assert(noPhone.momentos.length === 0, "unmatched teacher has no momentos");

const unmatched = rows[2];
assert(unmatched.matched === false, "unknown phone stays unmatched");
assert(unmatched.video_count === 0, "unknown phone has no videos");
assert(unmatched.momentos.length === 0, "unknown phone has no momentos");

const recordedOnly = buildMomentoRows(
  [{ name: "Older Video", phone: "9886646667", region: "Karnataka" }],
  [{ _id: "old-1", phone: "9886646667", status: "pending" }],
  [
    {
      nomination_id: "old-1",
      category_icon_filename: null,
      video_url: "https://example.com/old.mp4",
      generation_status: "generated",
    },
  ]
);
assert(recordedOnly[0].video_count === 1, "generated video without icon still counts");
assert(recordedOnly[0].momentos.length === 0, "missing stored icon must not invent a momento");
assert(recordedOnly[0].videos[0].category_icon_label === null, "missing filename stays null");

const groupNames = buildMomentoRows(
  [{ name: "Mapped Teacher", phone: "9845185324", region: "Karnataka" }],
  [{ _id: "g1", phone: "9845185324", status: "pending" }],
  [
    {
      nomination_id: "g1",
      category_icon_filename: "Group-8.svg",
      video_url: "https://example.com/g1.mp4",
      generation_status: "generated",
    },
  ]
);
assert(groupNames[0].momentos[0] === "knowledge icon", "Group-8.svg must display as knowledge icon");

const motivation = buildMomentoRows(
  [{ name: "Mapped Teacher 2", phone: "9845185325", region: "Karnataka" }],
  [{ _id: "g0", phone: "9845185325", status: "pending" }],
  [
    {
      nomination_id: "g0",
      category_icon_filename: "Group.svg",
      video_url: "https://example.com/g0.mp4",
      generation_status: "generated",
    },
  ]
);
assert(motivation[0].momentos[0] === "motivation icon", "Group.svg must display as motivation icon");

assert(TELANGANA_MOMENTO_TEACHERS.length === 36, "Telangana roster should keep all 36 provided rows");
assert(
  TELANGANA_MOMENTO_TEACHERS.every((row) => row.region === "Telangana"),
  "Telangana roster region must be Telangana"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Saundarya madam" && row.phone === "8501001100"),
  "Telangana teachers must be included in the combined roster"
);
assert(
  TELANGANA_MOMENTO_TEACHERS.find((row) => row.name === "Harish sir")?.phone === "",
  "Harish sir has no usable phone"
);
assert(ANDHRA_PRADESH_MOMENTO_TEACHERS.length === 98, "Andhra Pradesh roster should keep all 98 provided rows");
assert(
  ANDHRA_PRADESH_MOMENTO_TEACHERS.every((row) => row.region === "Andhra Pradesh"),
  "Andhra Pradesh roster region must be Andhra Pradesh"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Thoram lalita siva jyothi" && row.phone === "6309745626"),
  "Andhra Pradesh teachers must be included in the combined roster"
);
assert(TAMIL_NADU_MOMENTO_TEACHERS.length === 44, "Tamil Nadu roster should keep all 44 provided rows");
assert(
  TAMIL_NADU_MOMENTO_TEACHERS.every((row) => row.region === "Tamil Nadu"),
  "Tamil Nadu roster region must be Tamil Nadu"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Mercy anita" && row.phone === "9585831056"),
  "Tamil Nadu teachers must be included in the combined roster"
);
assert(UTTAR_PRADESH_MOMENTO_TEACHERS.length === 100, "Uttar Pradesh roster should keep all 100 provided rows");
assert(
  UTTAR_PRADESH_MOMENTO_TEACHERS.every((row) => row.region === "Uttar Pradesh"),
  "Uttar Pradesh roster region must be Uttar Pradesh"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Tulika gupta" && row.phone === "7985940291"),
  "Uttar Pradesh teachers must be included in the combined roster"
);

console.log("momentos.selftest ok");
