# Trigger-Academy-RP-pack

มอดแพ็กของเซิร์ฟ Trigger Academy RP — ซิงก์ให้ผู้เล่นอัตโนมัติด้วย **MOVEXTSync** (by MOVEXT)

## เพิ่ม / อัปเดต / ลบมอด

1. ไปที่ **Releases → TA v1 → ✏️ (Edit)**
2. **เพิ่มมอด:** ลากไฟล์ `.jar` ใส่ช่อง Attach binaries
   **ลบมอด:** กด 🗑 ข้างไฟล์ที่ไม่ใช้แล้ว
   **อัปเดตมอด:** ลบตัวเก่า แล้วลากตัวใหม่ใส่
3. กด **Update release**

เสร็จแล้ว — ภายใน ~5 นาที หุ่นยนต์ (GitHub Actions) จะสร้าง `manifest.json` ใหม่ให้เอง
ผู้เล่นจะได้มอดใหม่ตอนเปิดเกมครั้งถัดไป

> อยากให้อัปเดตทันที: แท็บ **Actions → Update manifest → Run workflow**

## อัปเดต MOVEXTSync เอง

อัปโหลด `movextsync-<เวอร์ชัน>.jar` ใส่ Release เหมือนมอดทั่วไป หุ่นยนต์จะตั้งเป็นตัวที่ผู้เล่นต้องใช้ให้เอง (เลือกเวอร์ชันสูงสุด)

## ไฟล์ในนี้

| ไฟล์ | คืออะไร |
|---|---|
| `manifest.json` | รายการมอดที่ผู้เล่นต้องมี — **หุ่นยนต์เขียนให้ ไม่ต้องแก้เอง** ยกเว้นช่อง `bannedModIds`, `bannedFiles`, `removeUnlisted`, `allowedExtras`, `packName` ซึ่งแก้ได้และหุ่นยนต์จะเก็บไว้ |
| `extra-mods.json` | มอดที่โหลดจากเว็บอื่น (เช่น Modrinth) แทน Release |
| `original-names.json` | ชื่อไฟล์จริงของมอดที่ GitHub เปลี่ยนชื่อให้ตอนอัปโหลด |
| `tools/build-manifest.mjs` | สคริปต์ของหุ่นยนต์ |

ต้องใช้ Forge **1.20.1 - 47.4.16**
