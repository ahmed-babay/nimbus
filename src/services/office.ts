import { deflateRawSync } from 'node:zlib'

/**
 * Word and PowerPoint files, written from scratch.
 *
 * Both formats are ZIP archives full of XML — that is all Office Open XML is —
 * so producing them needs no library, no service and no account. That matters
 * here beyond tidiness: every alternative is a paid API or a native dependency
 * that has to be rebuilt for Electron, and a meeting summary that can only
 * leave as a .txt is a note, whereas one that leaves as a .docx is a document
 * you can send to someone.
 *
 * Everything below is deliberately minimal. A real Word file has forty parts;
 * a valid one has three. The parts that are here are the ones the format
 * genuinely requires, and each is written out in full rather than templated,
 * because a missing relationship in OOXML fails as "the file is corrupt" with
 * no indication of which of the forty parts was wrong.
 */

// --- ZIP container --------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** 1980-01-01 in MS-DOS date format — the epoch the ZIP spec starts at. */
const DOS_EPOCH_DATE = 0x21

/**
 * A ZIP archive, deflated.
 *
 * Written by hand rather than shelled out to, so this works identically on a
 * machine with nothing installed.
 */
function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data)
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt16LE(0, 10) // modified time
    local.writeUInt16LE(DOS_EPOCH_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    parts.push(local, name, compressed)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0) // central directory header
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(DOS_EPOCH_DATE, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30) // extra
    record.writeUInt16LE(0, 32) // comment
    record.writeUInt16LE(0, 34) // disk number
    record.writeUInt16LE(0, 36) // internal attributes
    record.writeUInt32LE(0, 38) // external attributes
    record.writeUInt32LE(offset, 42) // where the local header is
    central.push(record, name)

    offset += local.length + name.length + compressed.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...parts, directory, end])
}

const file = (name: string, xml: string): ZipEntry => ({ name, data: Buffer.from(xml, 'utf8') })

/**
 * XML-escapes text.
 *
 * Not optional decoration: this content is a transcript of whatever people
 * said, and one "R&D" or "revenue < target" in a meeting produces a file Word
 * refuses to open at all.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML 1.0 even escaped, and speech-to-text
    // output occasionally carries one through.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

// --- Word -----------------------------------------------------------------

export interface DocumentSection {
  heading: string
  /** Rendered as bullets when `bullets`, otherwise as paragraphs. */
  body: string[]
  bullets?: boolean
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function wordParagraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  // Preserved whitespace, or Word collapses the indentation out of anything
  // that was laid out to be read as a list.
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/**
 * Word's built-in styles are referenced by id, and the ids have to be defined
 * in styles.xml even though Word knows them — a document referencing an
 * undefined style opens with the text unformatted rather than failing, which
 * is the confusing kind of broken.
 */
function wordStyles(): string {
  const heading = (id: string, size: number, before: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/>` +
    `<w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${id === 'Title' ? 0 : 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${size}"/></w:rPr></w:style>`

  return (
    `${DECL}<w:styles ${W_NS}>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>` +
    `<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>` +
    heading('Title', 44, 0) +
    heading('Heading1', 30, 320) +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>` +
    `<w:rPr><w:i/><w:color w:val="5A5A5A"/><w:sz w:val="20"/></w:rPr></w:style>` +
    `</w:styles>`
  )
}

/** A Word document: a title, a subtitle, then headed sections. */
export function buildDocx(title: string, subtitle: string, sections: DocumentSection[]): Buffer {
  const body = [wordParagraph(title, 'Title'), wordParagraph(subtitle, 'Quote')]

  for (const section of sections) {
    if (section.body.length === 0) continue
    body.push(wordParagraph(section.heading, 'Heading1'))
    for (const line of section.body) {
      // Bulleted with a literal character rather than a numbering definition.
      // numbering.xml is another part, another relationship and another way to
      // produce a file that will not open, to render a dot.
      body.push(wordParagraph(section.bullets ? `•  ${line}` : line))
    }
  }

  const document =
    `${DECL}<w:document ${W_NS}><w:body>${body.join('')}` +
    // A4 with 2.5cm margins, in twentieths of a point.
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418"/></w:sectPr>` +
    `</w:body></w:document>`

  return zip([
    file(
      '[Content_Types].xml',
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `</Types>`
    ),
    file(
      '_rels/.rels',
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`
    ),
    file('word/document.xml', document),
    file('word/styles.xml', wordStyles()),
    file(
      'word/_rels/document.xml.rels',
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`
    )
  ])
}

// --- PowerPoint -----------------------------------------------------------

export interface Slide {
  title: string
  bullets: string[]
}

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

/** 16:9, in EMU — the unit PowerPoint measures everything in. */
const SLIDE_W = 12192000
const SLIDE_H = 6858000

function shape(id: number, name: string, x: number, y: number, cx: number, cy: number, body: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`
  )
}

function slideXml(slide: Slide): string {
  const title =
    `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US" sz="3200" b="1" dirty="0">` +
    `<a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr>` +
    `<a:t>${esc(slide.title)}</a:t></a:r></a:p>`

  const bullets = slide.bullets.length
    ? slide.bullets
        .map(
          (line) =>
            `<a:p><a:pPr marL="285750" indent="-285750"><a:buChar char="•"/></a:pPr>` +
            `<a:r><a:rPr lang="en-US" sz="1800" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>`
        )
        .join('')
    : `<a:p><a:endParaRPr lang="en-US"/></a:p>`

  return (
    `${DECL}<p:sld ${P_NS}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shape(2, 'Title', 838200, 610000, SLIDE_W - 1676400, 1200000, title) +
    shape(3, 'Content', 838200, 1950000, SLIDE_W - 1676400, SLIDE_H - 2560000, bullets) +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  )
}

/**
 * The theme is not optional and not small.
 *
 * PowerPoint refuses to open a presentation whose master has no theme, and the
 * theme has to declare a full colour scheme, both font schemes and a complete
 * format scheme — three fills, three lines, three effects — or it is rejected
 * as malformed. This is the shortest one that is actually accepted.
 */
function themeXml(): string {
  const fills =
    `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>`
  const lines =
    `<a:lnStyleLst>` +
    [6350, 12700, 19050]
      .map(
        (w) =>
          `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
          `<a:prstDash val="solid"/></a:ln>`
      )
      .join('') +
    `</a:lnStyleLst>`
  const effects =
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>`
  const backgrounds =
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>`

  const colour = (tag: string, value: string): string =>
    `<a:${tag}><a:srgbClr val="${value}"/></a:${tag}>`

  return (
    `${DECL}<a:theme ${A_NS} name="Nimbus"><a:themeElements>` +
    `<a:clrScheme name="Nimbus">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    colour('dk2', '1F3864') +
    colour('lt2', 'EEF2F8') +
    colour('accent1', '4650C8') +
    colour('accent2', '6E7BFF') +
    colour('accent3', '35A9CA') +
    colour('accent4', '43B587') +
    colour('accent5', 'D9694C') +
    colour('accent6', 'E0B64F') +
    colour('hlink', '0563C1') +
    colour('folHlink', '954F72') +
    `</a:clrScheme>` +
    `<a:fontScheme name="Nimbus">` +
    `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="Nimbus">${fills}${lines}${effects}${backgrounds}</a:fmtScheme>` +
    `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  )
}

/** Shared by the master and the layout — both need a spTree and a colour map. */
function emptyTree(): string {
  return (
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`
  )
}

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

export function buildPptx(slides: Slide[]): Buffer {
  const rels = (items: string[]): string =>
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`

  // Slide ids start at 256; PowerPoint reserves everything below.
  const slideIds = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join('')

  const entries: ZipEntry[] = [
    file(
      '[Content_Types].xml',
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
        `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
        `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
        slides
          .map(
            (_, i) =>
              `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
          )
          .join('') +
        `</Types>`
    ),
    file('_rels/.rels', rels([rel('rId1', 'officeDocument', 'ppt/presentation.xml')])),
    file(
      'ppt/presentation.xml',
      `${DECL}<p:presentation ${P_NS}>` +
        `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
        `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
        `</p:presentation>`
    ),
    file(
      'ppt/_rels/presentation.xml.rels',
      rels([
        rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
        ...slides.map((_, i) => rel(`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`)),
        rel(`rId${slides.length + 2}`, 'theme', 'theme/theme1.xml')
      ])
    ),
    file(
      'ppt/slideMasters/slideMaster1.xml',
      `${DECL}<p:sldMaster ${P_NS}><p:cSld>${emptyTree()}</p:cSld>${CLR_MAP}` +
        `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
    ),
    file(
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels([
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
        rel('rId2', 'theme', '../theme/theme1.xml')
      ])
    ),
    file(
      'ppt/slideLayouts/slideLayout1.xml',
      `${DECL}<p:sldLayout ${P_NS} type="titleOnly" preserve="1"><p:cSld name="Title Only">${emptyTree()}</p:cSld>` +
        `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
    ),
    file(
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      rels([rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')])
    ),
    file('ppt/theme/theme1.xml', themeXml())
  ]

  slides.forEach((slide, i) => {
    entries.push(file(`ppt/slides/slide${i + 1}.xml`, slideXml(slide)))
    entries.push(
      file(
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        rels([rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')])
      )
    )
  })

  return zip(entries)
}
