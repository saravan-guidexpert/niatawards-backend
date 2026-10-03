import { ANDHRA_PRADESH_MOMENTO_TEACHERS } from "../src/data/andhraPradeshMomentoTeachers";
import { KARNATAKA_ONE_MOMENTO_TEACHERS } from "../src/data/karnatakaOneMomentoTeachers";
import { KARNATAKA_MOMENTO_TEACHERS } from "../src/data/karnatakaMomentoTeachers";
import { TAMIL_NADU_MOMENTO_TEACHERS } from "../src/data/tamilNaduMomentoTeachers";
import { ODISHA_MOMENTO_TEACHERS } from "../src/data/odishaMomentoTeachers";
import { RAJASTHAN_MOMENTO_TEACHERS } from "../src/data/rajasthanMomentoTeachers";
import { UTTAR_PRADESH_MOMENTO_TEACHERS } from "../src/data/uttarPradeshMomentoTeachers";
import { MOMENTO_TEACHERS } from "../src/data/momentoTeachers";
import { TELANGANA_MOMENTO_TEACHERS } from "../src/data/telanganaMomentoTeachers";
import { buildMomentoRows } from "../src/lib/momentos";
import type { MomentoTeacher } from "../src/data/karnatakaMomentoTeachers";

const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

const roster: MomentoTeacher[] = [
  { name: "G KAVITHA", phone: "9535397094", region: "Karnataka 2" },
  { name: "Dr Bhurli Prahlad", phone: "", region: "Karnataka 2" },
  { name: "Unmatched Teacher", phone: "9000000001", region: "Karnataka 2" },
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
assert(noPhone.momentos.length === 1, "unmatched teacher still gets one momento");
assert(
  ["motivation icon", "support champion", "role model icon", "guiding star", "discipline champion", "caring hero", "classroom rockstar", "creative spark", "knowledge icon", "confidence builder", "patience champion", "inspiration icon"].includes(noPhone.momentos[0]),
  "fallback momento must be one of the 12 category icons"
);

const unmatched = rows[2];
assert(unmatched.matched === false, "unknown phone stays unmatched");
assert(unmatched.video_count === 0, "unknown phone has no videos");
assert(unmatched.momentos.length === 1, "teacher without a video still gets one momento");
const again = buildMomentoRows(roster, [], []);
assert(again[2].momentos[0] === unmatched.momentos[0], "fallback momento stays the same for the same teacher");

const recordedOnly = buildMomentoRows(
  [{ name: "Older Video", phone: "9886646667", region: "Karnataka 2" }],
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
assert(recordedOnly[0].momentos.length === 1, "missing stored icon still gets a fallback momento");
assert(recordedOnly[0].videos[0].category_icon_label === null, "missing filename stays null");

const groupNames = buildMomentoRows(
  [{ name: "Mapped Teacher", phone: "9845185324", region: "Karnataka 2" }],
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
  [{ name: "Mapped Teacher 2", phone: "9845185325", region: "Karnataka 2" }],
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

assert(KARNATAKA_ONE_MOMENTO_TEACHERS.length === 143, "Karnataka 1 roster should keep all 143 provided rows");
assert(
  KARNATAKA_ONE_MOMENTO_TEACHERS.every((row) => row.region === "Karnataka 1"),
  "Karnataka 1 roster region must be Karnataka 1"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Vinaya Mk" && row.phone === "9964594386" && row.region === "Karnataka 1"),
  "Karnataka 1 teachers must be included in the combined roster"
);
assert(
  KARNATAKA_ONE_MOMENTO_TEACHERS.find((row) => row.name === "Ashwath")?.phone === "",
  "Ashwath has no usable phone"
);
assert(
  KARNATAKA_ONE_MOMENTO_TEACHERS.find((row) => row.name === "Rabbiya")?.phone === "",
  "Rabbiya has no usable phone"
);
assert(
  KARNATAKA_ONE_MOMENTO_TEACHERS.find((row) => row.name === "Gulfa")?.phone === "8861472518",
  "Gulfa phone should be normalized"
);
assert(
  KARNATAKA_MOMENTO_TEACHERS.every((row) => row.region === "Karnataka 2"),
  "Existing Karnataka roster region must be Karnataka 2"
);
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
assert(RAJASTHAN_MOMENTO_TEACHERS.length === 144, "Rajasthan roster should keep all 144 provided rows");
assert(
  RAJASTHAN_MOMENTO_TEACHERS.every((row) => row.region === "Rajasthan"),
  "Rajasthan roster region must be Rajasthan"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Devendra Agrawal" && row.phone === "9414752385" && row.region === "Rajasthan"),
  "Rajasthan teachers must be included in the combined roster"
);
assert(
  RAJASTHAN_MOMENTO_TEACHERS.find((row) => row.name === "Atul Gupta")?.phone === "",
  "Atul Gupta has no precise phone match"
);
assert(
  RAJASTHAN_MOMENTO_TEACHERS.find((row) => row.name === "PRIYANKA SHARMA")?.phone === "9982903555",
  "Priyanka Sharma should use the Jaipur Subodh phone stored as Priyenka Sharma"
);
assert(ODISHA_MOMENTO_TEACHERS.length === 36, "Odisha roster should keep all 36 provided rows");
assert(
  ODISHA_MOMENTO_TEACHERS.every((row) => row.region === "Odisha"),
  "Odisha roster region must be Odisha"
);
assert(
  MOMENTO_TEACHERS.some((row) => row.name === "Jiban Kishore Mishra" && row.phone === "9777012425" && row.region === "Odisha"),
  "Odisha teachers must be included in the combined roster"
);
assert(
  ODISHA_MOMENTO_TEACHERS.find((row) => row.name === "Sukant Mohaptra")?.phone === "",
  "Sukant Mohaptra has no precise phone match"
);
assert(
  ODISHA_MOMENTO_TEACHERS.find((row) => row.name === "Rajendra Kumar Padhi")?.phone === "9439011323",
  "Rajendra Kumar Padhi phone should match the nomination"
);

console.log("momentos.selftest ok");
