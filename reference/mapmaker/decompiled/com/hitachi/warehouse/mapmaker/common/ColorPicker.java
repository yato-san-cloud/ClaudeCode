/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.common;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.FlowLayout;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.ArrayList;
import java.util.List;
import javax.swing.JButton;
import javax.swing.JColorChooser;
import javax.swing.JDialog;
import javax.swing.JPanel;

public class ColorPicker
extends JDialog {
    JColorChooser colorChooser;
    JButton btnOK;
    JButton btnCancel;
    JButton btnDefault;
    Color defaultColor;
    Color selectedColor;
    List<ColorPickerListener> listeners = new ArrayList<ColorPickerListener>();

    public ColorPicker(Color initial, final Color defaultColor) {
        this.defaultColor = defaultColor;
        JPanel pnlAll = new JPanel();
        pnlAll.setLayout(new BorderLayout());
        this.colorChooser = new JColorChooser(initial);
        pnlAll.add((Component)this.colorChooser, "Center");
        JPanel pnlControl = new JPanel(new FlowLayout());
        this.btnOK = new JButton("OK");
        pnlControl.add(this.btnOK);
        this.btnOK.requestFocus();
        this.getRootPane().setDefaultButton(this.btnOK);
        this.btnOK.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ColorPicker.this.selectedColor = ColorPicker.this.colorChooser.getColor();
                ColorPicker.this.setVisible(false);
                ColorPicker.this.dispose();
                ColorPicker.this.dispatchColorSelected(ColorPicker.this.selectedColor);
            }
        });
        this.btnCancel = new JButton("Cancel");
        pnlControl.add(this.btnCancel);
        this.btnCancel.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ColorPicker.this.setVisible(false);
                ColorPicker.this.dispose();
                ColorPicker.this.dispatchCanceled();
            }
        });
        this.btnDefault = new JButton("既定色");
        pnlControl.add(this.btnDefault);
        this.btnDefault.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ColorPicker.this.colorChooser.setColor(defaultColor);
            }
        });
        pnlAll.add((Component)pnlControl, "South");
        this.add(pnlAll);
        this.pack();
    }

    public void open(Component owner) {
        this.setLocationRelativeTo(owner);
        this.setModal(true);
        this.setVisible(true);
    }

    public Color getColor() {
        return this.selectedColor;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public ColorPickerListener addListener(ColorPickerListener listener) {
        List<ColorPickerListener> list = this.listeners;
        synchronized (list) {
            this.listeners.add(listener);
        }
        return listener;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void removeListener(ColorPickerListener listener) {
        List<ColorPickerListener> list = this.listeners;
        synchronized (list) {
            this.listeners.remove(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchColorSelected(Color color) {
        List<ColorPickerListener> list = this.listeners;
        synchronized (list) {
            for (ColorPickerListener listener : this.listeners) {
                listener.colorSelected(color);
            }
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchCanceled() {
        List<ColorPickerListener> list = this.listeners;
        synchronized (list) {
            for (ColorPickerListener listener : this.listeners) {
                listener.canceled();
            }
        }
    }

    public static abstract class ColorPickerListener {
        public abstract void colorSelected(Color var1);

        public void canceled() {
        }
    }
}

