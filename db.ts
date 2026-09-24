import { sql } from "bun";


export async function saveCategory(
  name: string,
  url: string,
  parentId: number | null,
  depth: number
) {
  const rows = await sql`
    INSERT INTO categories (
      name,
      url,
      parent_id,
      depth
    )
    VALUES (
      ${name},
      ${url},
      ${parentId},
      ${depth}
    )
    ON CONFLICT (url)
    DO NOTHING
    RETURNING id
  `;

  return rows[0]?.id ?? null;
}



