export function pdfFixture(count = 2, mixedSizes = false, imageOnly = false, withOutline = false) {
  const pages = Array.from({ length: count }, (_, index) => {
    const landscape = mixedSizes && index % 4 === 1;
    return { number: index + 1, width: landscape ? 640 : 450, height: landscape ? 450 : 640 };
  });
  const outlineRoot = 4 + count * 2;
  const pageRef = (page: number) => 4 + (Math.min(page, count) - 1) * 2;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${withOutline ? `/Outlines ${outlineRoot} 0 R /Names << /Dests << /Names [(methods) [${pageRef(3)} 0 R /XYZ 0 260 null]] >> >>` : ''} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pages.flatMap(({ number, width, height }, index) => {
      const stream = [
        `0.19 0.36 0.58 rg BT /F1 10 Tf 40 ${height - 42} Td (READING NOTES / ${String(number).padStart(2, '0')}) Tj ET`,
        `0.14 0.20 0.29 rg BT /F1 25 Tf 40 ${height - 94} Td (A quiet page - ${number}) Tj ET`,
        `0.86 0.89 0.93 RG 40 ${height - 114} m ${width - 40} ${height - 114} l S`,
        ...Array.from(
          { length: 3 },
          (_, section) =>
            `BT /F1 12 Tf 40 ${height - 151 - section * 65} Td 19 TL (Read at your own pace.) Tj T* (One page flows naturally into the next.) Tj ET`,
        ),
        `0.45 0.52 0.61 rg BT /F1 10 Tf 40 32 Td (PAGE ${number} / ${count}) Tj ET`,
      ]
        .filter((line) => !imageOnly || !line.includes('BT'))
        .join('\n');
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  if (withOutline)
    objects.push(
      `<< /Type /Outlines /First ${outlineRoot + 1} 0 R /Last ${outlineRoot + 4} 0 R /Count 4 >>`,
      `<< /Title (1 Introduction) /Parent ${outlineRoot} 0 R /Next ${outlineRoot + 2} 0 R /Dest [${pageRef(1)} 0 R /Fit] >>`,
      `<< /Title (2 Methods) /Parent ${outlineRoot} 0 R /Prev ${outlineRoot + 1} 0 R /Next ${outlineRoot + 4} 0 R /Dest (methods) /First ${outlineRoot + 3} 0 R /Last ${outlineRoot + 3} 0 R /Count 1 >>`,
      `<< /Title (2.1 Results) /Parent ${outlineRoot + 2} 0 R /Dest [${pageRef(5)} 0 R /FitH 480] >>`,
      `<< /Title (Unresolved chapter) /Parent ${outlineRoot} 0 R /Prev ${outlineRoot + 2} 0 R /Dest (missing-chapter) >>`,
    );
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
