// The complete set of library-owned blob references. The id expression is an
// internal SQL expression such as `blobs.id` or `b.id`, never user input.
export function blobReferences(id: string): string {
  return [
    `EXISTS(SELECT 1 FROM versions v WHERE v.body_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM version_assets a WHERE a.blob_id=${id})`,
    `EXISTS(SELECT 1 FROM nodes n WHERE n.file_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM nodes n WHERE n.icon_blob_id=${id})`,
    `EXISTS(SELECT 1 FROM nodes n WHERE n.icon_file_id=${id})`,
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

// Which notes hold each blob in `set` (an SQL expression such as
// `(SELECT value FROM json_each(?))`): one query of rows (blob,node) per kind
// of reference, since D1 limits compound SELECTs. A link to a PDF or image in
// the library refers to that entry's file, which follows the entry and is not
// held by the linking note. Clips belong to no note and are not listed. Keep
// in step with blobReferences.
// Not the file of a PDF or image entry.
export const NOT_DOCUMENT = (id: string) => `NOT EXISTS(SELECT 1 FROM nodes o WHERE o.file_blob_id=${id})`;
export function referencingNodes(set: string): string[] {
  return [
    `SELECT v.body_blob_id blob,v.node_id node FROM versions v WHERE v.body_blob_id IN ${set}`,
    `SELECT a.blob_id blob,(SELECT node_id FROM versions WHERE id=a.version_id) node FROM version_assets a WHERE a.blob_id IN ${set} AND ${NOT_DOCUMENT('a.blob_id')}`,
    `SELECT n.file_blob_id blob,n.id node FROM nodes n WHERE n.file_blob_id IN ${set}`,
    `SELECT n.icon_blob_id blob,n.id node FROM nodes n WHERE n.icon_blob_id IN ${set}`,
    `SELECT n.icon_file_id blob,n.id node FROM nodes n WHERE n.icon_file_id IN ${set}`,
    `SELECT k.cover_blob_id blob,k.node_id node FROM books k WHERE k.cover_blob_id IN ${set}`,
    `SELECT m.body_blob_id blob,m.node_id node FROM assistant_messages m WHERE m.body_blob_id IN ${set}`,
    `SELECT m.image_blob_id blob,m.node_id node FROM assistant_messages m WHERE m.image_blob_id IN ${set}`,
    `SELECT a.blob_id blob,(SELECT node_id FROM assistant_messages WHERE id=a.message_id) node FROM assistant_message_files a WHERE a.blob_id IN ${set}`,
    `SELECT t.body_blob_id blob,t.node_id node FROM translations t WHERE t.body_blob_id IN ${set}`,
    `SELECT p.body_blob_id blob,p.node_id node FROM paper_translations p WHERE p.body_blob_id IN ${set}`,
    `SELECT n.body_blob_id blob,n.node_id node FROM annotations n WHERE n.body_blob_id IN ${set}`,
  ];
}
