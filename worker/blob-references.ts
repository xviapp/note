// The complete set of library-owned blob references. The id expression is an
// internal SQL expression such as `blobs.id` or `b.id`, never user input.
export function blobReferences(id: string): string {
  return [
    `EXISTS(SELECT 1 FROM versions v WHERE v.body_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM version_assets a WHERE a.blob_id=${id})`,
    `EXISTS(SELECT 1 FROM nodes n WHERE n.file_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM nodes n WHERE n.icon_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM books k WHERE k.cover_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM assistant_messages m WHERE m.body_blob_id=${id} OR m.image_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM assistant_message_files a WHERE a.blob_id=${id})`,
    `EXISTS(SELECT 1 FROM translations t WHERE t.body_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM paper_translations p WHERE p.body_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM annotations n WHERE n.body_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM clips c WHERE c.blob_id=${id})`,
  ].join('\n OR ');
}

export function blobUnreferenced(id: string): string {
  return `NOT (${blobReferences(id)})`;
}
