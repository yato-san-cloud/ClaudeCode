/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import java.awt.Dimension;
import javax.swing.JFrame;
import javax.swing.JPanel;

public class ObjectInfoFrame
extends JPanel {
    private static final long serialVersionUID = -6924572078398519395L;
    JPanel currentPanel;
    JFrame parent = null;

    public ObjectInfoFrame() {
        this.setPreferredSize(new Dimension(300, 0));
    }

    public void setEditor(JPanel panel) {
        if (this.currentPanel != null) {
            this.remove(this.currentPanel);
        }
        this.currentPanel = panel;
        if (this.currentPanel != null) {
            this.add(this.currentPanel);
        }
    }

    public JFrame openInDialog() {
        this.parent = new JFrame();
        this.parent.add(this);
        this.parent.setVisible(true);
        return this.parent;
    }
}

