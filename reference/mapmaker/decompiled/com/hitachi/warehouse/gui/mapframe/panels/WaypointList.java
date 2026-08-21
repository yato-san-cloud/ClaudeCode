/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe.panels;

import com.hitachi.warehouse.model.map.Waypoint;
import java.util.Collection;
import java.util.Iterator;
import java.util.List;
import java.util.ListIterator;

public class WaypointList
implements List<Waypoint> {
    public final int maxCapacity;
    public final Waypoint[] rawArray;
    private int size = 0;

    @Override
    public int size() {
        return this.size;
    }

    public WaypointList(int maxCapacity) {
        this.maxCapacity = maxCapacity;
        this.rawArray = new Waypoint[maxCapacity];
    }

    @Override
    public boolean isEmpty() {
        return this.size == 0;
    }

    @Override
    public boolean contains(Object o) {
        return false;
    }

    @Override
    public Iterator<Waypoint> iterator() {
        final int size = this.size;
        return new Iterator<Waypoint>(){
            int i = 0;

            @Override
            public boolean hasNext() {
                return this.i < size;
            }

            @Override
            public Waypoint next() {
                return WaypointList.this.rawArray[this.i++];
            }

            @Override
            public void remove() {
            }
        };
    }

    @Override
    public Object[] toArray() {
        return this.rawArray;
    }

    @Override
    public <T> T[] toArray(T[] a) {
        return null;
    }

    @Override
    public boolean add(Waypoint e) {
        this.rawArray[this.size++] = e;
        return true;
    }

    @Override
    public boolean remove(Object o) {
        return false;
    }

    @Override
    public boolean containsAll(Collection<?> c) {
        return false;
    }

    @Override
    public boolean addAll(Collection<? extends Waypoint> cs) {
        for (Waypoint waypoint : cs) {
            this.add(waypoint);
        }
        return true;
    }

    @Override
    public boolean addAll(int index, Collection<? extends Waypoint> c) {
        return false;
    }

    @Override
    public boolean removeAll(Collection<?> c) {
        return false;
    }

    @Override
    public boolean retainAll(Collection<?> c) {
        return false;
    }

    @Override
    public void clear() {
        this.size = 0;
    }

    @Override
    public Waypoint get(int index) {
        return this.rawArray[index];
    }

    @Override
    public Waypoint set(int index, Waypoint element) {
        this.rawArray[index] = element;
        return this.rawArray[index];
    }

    @Override
    public void add(int index, Waypoint element) {
    }

    @Override
    public Waypoint remove(int index) {
        return null;
    }

    @Override
    public int indexOf(Object o) {
        return 0;
    }

    @Override
    public int lastIndexOf(Object o) {
        return 0;
    }

    @Override
    public ListIterator<Waypoint> listIterator() {
        return null;
    }

    @Override
    public ListIterator<Waypoint> listIterator(int index) {
        return null;
    }

    @Override
    public List<Waypoint> subList(int fromIndex, int toIndex) {
        return null;
    }
}

