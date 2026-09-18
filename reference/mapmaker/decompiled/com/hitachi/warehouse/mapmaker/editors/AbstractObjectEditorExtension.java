/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.mapmaker.editors.ShelfEditor;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.ArrayList;
import javax.swing.BoxLayout;
import javax.swing.JCheckBox;
import javax.swing.JPanel;

public class AbstractObjectEditorExtension
extends JPanel {
    private static final long serialVersionUID = 7084134403262228570L;
    public WorldMap map;
    public ArrayList<AbstractObject> editingObjects = new ArrayList();
    public JCheckBox chkLock;

    public AbstractObjectEditorExtension(final AbstractObjectEditor editer, final ArrayList<AbstractObject> editingObjects, WorldMap map) {
        this.map = map;
        this.editingObjects.clear();
        this.editingObjects = editingObjects;
        this.setLayout(new BoxLayout(this, 1));
        this.chkLock = new JCheckBox();
        this.chkLock.setText("編集ロック");
        this.chkLock.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                for (AbstractObject obj : editingObjects) {
                    ShelfEditor shelfEditor;
                    if (AbstractObjectEditorExtension.this.chkLock.isSelected()) {
                        obj.setEditLock(true);
                    } else {
                        obj.setEditLock(false);
                    }
                    if (editer == null) continue;
                    if (AbstractObjectEditorExtension.this.chkLock.isSelected()) {
                        editer.btnDelete.setEnabled(false);
                        if (!ShelfEditor.class.isInstance(editer)) continue;
                        shelfEditor = (ShelfEditor)editer;
                        shelfEditor.rbSizeLeftTop.setEnabled(false);
                        shelfEditor.rbSizeRightTop.setEnabled(false);
                        shelfEditor.rbSizeLeftBottom.setEnabled(false);
                        shelfEditor.rbSizeRightBottom.setEnabled(false);
                        shelfEditor.txtHeight.setEditable(false);
                        shelfEditor.txtWidth.setEditable(false);
                        continue;
                    }
                    editer.btnDelete.setEnabled(true);
                    if (!ShelfEditor.class.isInstance(editer)) continue;
                    shelfEditor = (ShelfEditor)editer;
                    shelfEditor.rbSizeLeftTop.setEnabled(true);
                    shelfEditor.rbSizeRightTop.setEnabled(true);
                    shelfEditor.rbSizeLeftBottom.setEnabled(true);
                    shelfEditor.rbSizeRightBottom.setEnabled(true);
                    shelfEditor.txtHeight.setEditable(true);
                    shelfEditor.txtWidth.setEditable(true);
                }
            }
        });
        this.add(this.chkLock);
        this.updateGUIFromObject();
    }

    protected final void updateObjectFromGUI() {
    }

    protected final void updateGUIFromObject() {
        boolean editLock = false;
        for (AbstractObject obj : this.editingObjects) {
            if (!obj.getEditLock()) continue;
            editLock = true;
        }
        this.chkLock.setSelected(editLock);
    }
}

