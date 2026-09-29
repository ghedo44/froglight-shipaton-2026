package io.froglight.filedrop

import org.junit.Assert.*
import org.junit.Test

class FileDropEventBuilderTest {
    @Test
    fun `file-like requires clip data with items`() {
        assertFalse(FileDropEventBuilder.isFileLike(FileDropEventBuilder.ClipDescription(false, 0)))
        assertFalse(FileDropEventBuilder.isFileLike(FileDropEventBuilder.ClipDescription(true, 0)))
        assertFalse(FileDropEventBuilder.isFileLike(FileDropEventBuilder.ClipDescription(false, 2)))
        assertTrue(FileDropEventBuilder.isFileLike(FileDropEventBuilder.ClipDescription(true, 1)))
        assertTrue(FileDropEventBuilder.isFileLike(FileDropEventBuilder.ClipDescription(true, 3)))
    }

    @Test
    fun `display name wins over fallback`() {
        assertEquals("paper.pdf", FileDropEventBuilder.resolveName("paper.pdf", "fallback.pdf"))
    }

    @Test
    fun `fallback applies when display name is missing`() {
        assertEquals("fallback.pdf", FileDropEventBuilder.resolveName(null, "fallback.pdf"))
        assertEquals("fallback.pdf", FileDropEventBuilder.resolveName("  ", "fallback.pdf"))
    }

    @Test
    fun `blank names fall back to dropped-file`() {
        assertEquals("dropped-file", FileDropEventBuilder.resolveName(null, null))
        assertEquals("dropped-file", FileDropEventBuilder.resolveName("", ""))
        assertEquals("dropped-file", FileDropEventBuilder.resolveName("  ", null))
    }

    @Test
    fun `separators never survive into vault names`() {
        assertEquals("a-b", FileDropEventBuilder.resolveName("a/b", null))
        assertEquals("a-b", FileDropEventBuilder.resolveName("a\\b", null))
    }

    @Test
    fun `unknown size is omitted from the wire payload`() {
        val withSize = FileDropEventBuilder.fileJson("tok", "a.md", "text/markdown", 12)
        assertTrue(withSize.contains("\"size\":12"))
        val withoutSize = FileDropEventBuilder.fileJson("tok", "a.md", "text/markdown", null)
        assertFalse(withoutSize.contains("size"))
        val negative = FileDropEventBuilder.fileJson("tok", "a.md", null, -1)
        assertFalse(negative.contains("size"))
    }

    @Test
    fun `mime type is omitted when unknown`() {
        val withMime = FileDropEventBuilder.fileJson("tok", "a.md", "text/markdown", null)
        assertTrue(withMime.contains("mimeType"))
        val withoutMime = FileDropEventBuilder.fileJson("tok", "a.md", null, null)
        assertFalse(withoutMime.contains("mimeType"))
        val blankMime = FileDropEventBuilder.fileJson("tok", "a.md", "", null)
        assertFalse(blankMime.contains("mimeType"))
    }

    @Test
    fun `names are json escaped`() {
        val json = FileDropEventBuilder.fileJson("tok", "a\"b\\c.md", null, null)
        assertTrue(json.contains("a\\\"b\\\\c.md"))
        assertTrue(json.startsWith("{"))
        assertTrue(json.endsWith("}"))
    }

    @Test
    fun `tokens never appear as paths or uris`() {
        val json = FileDropEventBuilder.fileJson("drop-abc", "a.md", null, null)
        assertTrue(json.contains("drop-abc"))
        assertFalse(json.contains("content://"))
        assertFalse(json.contains("path"))
    }

    @Test
    fun `multiple items each keep their own token`() {
        val first = FileDropEventBuilder.fileJson("tok-1", "a.md", null, null)
        val second = FileDropEventBuilder.fileJson("tok-2", "b.md", null, null)
        assertTrue(first.contains("tok-1"))
        assertFalse(first.contains("tok-2"))
        assertTrue(second.contains("tok-2"))
    }
}
