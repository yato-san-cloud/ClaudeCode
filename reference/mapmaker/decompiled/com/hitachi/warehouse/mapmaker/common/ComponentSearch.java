/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.common;

import java.awt.Component;
import java.awt.Container;
import java.util.ArrayList;
import javax.swing.JPanel;

public class ComponentSearch {
    private ArrayList<Component> memberComponents = new ArrayList();

    public ComponentSearch() {
        this.memberComponents.clear();
    }

    public ArrayList<Component> getComponents(Container container) {
        this.memberComponents.clear();
        this.Serch(container);
        return this.memberComponents;
    }

    public boolean Exist(Container container, Component targetComponent) {
        this.memberComponents.clear();
        this.Serch(container);
        for (Component component : this.memberComponents) {
            if (!component.equals(targetComponent)) continue;
            return true;
        }
        return false;
    }

    private void Serch(Container container) {
        if (!JPanel.class.isInstance(container)) {
            return;
        }
        Component[] componentArray = container.getComponents();
        int n = componentArray.length;
        int n2 = 0;
        while (n2 < n) {
            Component component = componentArray[n2];
            this.memberComponents.add(component);
            if (JPanel.class.isInstance(component)) {
                this.Serch((Container)component);
            }
            ++n2;
        }
    }
}

