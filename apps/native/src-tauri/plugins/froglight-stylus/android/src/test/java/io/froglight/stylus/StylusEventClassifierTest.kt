package io.froglight.stylus

import android.view.MotionEvent
import org.junit.Assert.*
import org.junit.Test

class StylusEventClassifierTest {
    private val stylus = MotionEvent.TOOL_TYPE_STYLUS
    private val eraser = MotionEvent.TOOL_TYPE_ERASER
    private val mouse = MotionEvent.TOOL_TYPE_MOUSE
    private val finger = MotionEvent.TOOL_TYPE_FINGER

    @Test
    fun `stylus enter tracks device and reports proximity`() {
        val decision = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_ENTER,
            listOf(stylus),
            7,
            null,
            false,
        )
        assertFalse(decision.ignore)
        assertTrue(decision.entering)
        assertEquals(7, decision.deviceId)
        assertTrue(decision.proximityActive)
    }

    @Test
    fun `stylus move for tracked device is change-only`() {
        val decision = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_MOVE,
            listOf(stylus),
            7,
            7,
            true,
        )
        assertTrue(decision.ignore)
    }

    @Test
    fun `same stylus exit clears proximity`() {
        val decision = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_EXIT,
            listOf(stylus),
            7,
            7,
            true,
        )
        assertFalse(decision.ignore)
        assertTrue(decision.leaving)
        assertFalse(decision.proximityActive)
    }

    @Test
    fun `mouse hover exit never triggers pen proximity`() {
        val decision = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_EXIT,
            listOf(mouse),
            3,
            7,
            true,
        )
        assertTrue(decision.ignore)
        assertFalse(decision.leaving)
    }

    @Test
    fun `mouse hover enter never starts pen proximity`() {
        val decision = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_ENTER,
            listOf(mouse),
            3,
            null,
            false,
        )
        assertTrue(decision.ignore)
    }

    @Test
    fun `exit from different device id is ignored`() {
        val decision = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_EXIT,
            listOf(stylus),
            9,
            7,
            true,
        )
        assertTrue(decision.ignore)
    }

    @Test
    fun `contact classification separates stylus eraser and finger`() {
        assertEquals(
            StylusEventClassifier.ContactClassification(true, false),
            StylusEventClassifier.classifyContactTools(listOf(stylus, finger)),
        )
        assertEquals(
            StylusEventClassifier.ContactClassification(false, true),
            StylusEventClassifier.classifyContactTools(listOf(eraser)),
        )
        assertEquals(
            StylusEventClassifier.ContactClassification(false, false),
            StylusEventClassifier.classifyContactTools(listOf(mouse, finger)),
        )
    }

    @Test
    fun `multi-pointer with stylus plus finger still counts as stylus`() {
        val classification = StylusEventClassifier.classifyContactTools(
            listOf(finger, stylus),
        )
        assertTrue(classification.sawStylus)
    }

    @Test
    fun `eraser to pen transition stays device scoped`() {
        val enter = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_ENTER,
            listOf(eraser),
            11,
            null,
            false,
        )
        assertTrue(enter.entering)
        val exitOther = StylusEventClassifier.classifyHoverState(
            MotionEvent.ACTION_HOVER_EXIT,
            listOf(stylus),
            12,
            11,
            true,
        )
        assertTrue(exitOther.ignore)
    }

    @Test
    fun `eraser DOWN is active`() {
        assertTrue(
            StylusEventClassifier.eraserContactForState(
                true, MotionEvent.ACTION_DOWN, false,
            ),
        )
        assertTrue(
            StylusEventClassifier.eraserContactForState(
                true, MotionEvent.ACTION_MOVE, true,
            ),
        )
    }

    @Test
    fun `eraser UP resolves inactive even when tool still reports eraser`() {
        assertFalse(
            StylusEventClassifier.eraserContactForState(
                true, MotionEvent.ACTION_UP, true,
            ),
        )
    }

    @Test
    fun `eraser CANCEL resolves inactive`() {
        assertFalse(
            StylusEventClassifier.eraserContactForState(
                true, MotionEvent.ACTION_CANCEL, true,
            ),
        )
    }

    @Test
    fun `pen contact after eraser is not eraser-active`() {
        assertFalse(
            StylusEventClassifier.eraserContactForState(
                false, MotionEvent.ACTION_MOVE, true,
            ),
        )
    }

    @Test
    fun `unknown eraser action holds last state`() {
        assertTrue(
            StylusEventClassifier.eraserContactForState(
                true, MotionEvent.ACTION_SCROLL, true,
            ),
        )
        assertFalse(
            StylusEventClassifier.eraserContactForState(
                true, MotionEvent.ACTION_SCROLL, false,
            ),
        )
    }
}
